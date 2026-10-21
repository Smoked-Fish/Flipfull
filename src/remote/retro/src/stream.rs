use crate::cpu;
use crate::keypad::Keypad;
use crate::libretro::Frontend;
use crate::panel::Panel;
use crate::service::state;
use crate::ws;
use log::{info, warn};
use serde_json::Value;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const APP: &str = "http://retro.localhost";

const KIND_FRAME: u8 = 1;
const PAUSED: u8 = 2;
const HOLD: u8 = 4;
const FRAME_HEADER: usize = 32;
const PREFIX: usize = 4;

const SYNC_WITHIN: f64 = 0.015;
// drawn 10ms or more before the refresh the compositor takes it, 8-10 86%, 6-8 half, less none
const LEAD: f64 = 0.0095;
const EARLIER: f64 = 0.001;
const LATER: f64 = 0.00004;
const EARLY: f64 = 0.022;
const EARLY_MIN: f64 = 0.004;
const EARLY_MAX: f64 = 0.05;
// b2g presents 9-24ms after its refresh, 95% within 22
const MARGIN: f64 = 0.023;
const MARGIN_MIN: f64 = 0.021;
const MARGIN_MAX: f64 = 0.027;
const MARGIN_STEP: f64 = 0.001;
const MARGIN_DECAY: f64 = 0.00002;
const SEEN: Duration = Duration::from_millis(3);
const FAST_MAX: u32 = 20;
const FAST_SHARE: f64 = 0.75;
const FAST_KEY: u16 = 158;
const AHEAD_MAX: u32 = 2;
const BEHIND: u32 = 4;
const IDLE: Duration = Duration::from_secs(3600);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const STATS_EVERY: u32 = 1800;

enum Command {
    Client(u32, TcpStream),
    Gone(u32),
    Message(u32, Value),
    Play(TcpStream, Value),
    Stop,
}

struct Stream {
    url: String,
    commands: Mutex<Sender<Command>>,
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("/dev/urandom: {}", e))?;
    Ok(buf.iter().map(|b| format!("{:02x}", b)).collect())
}

fn start() -> Result<Stream, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("no socket for the frames: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let path = format!("/{}", random_hex(16)?);
    let url = format!("ws://127.0.0.1:{}{}", port, path);
    let (tx, rx) = channel();
    let accepted = tx.clone();
    thread::Builder::new()
        .name("retro-accept".into())
        .spawn(move || {
            static NEXT: AtomicU32 = AtomicU32::new(1);
            for stream in listener.incoming().flatten() {
                let id = NEXT.fetch_add(1, Ordering::Relaxed);
                let (path, tx) = (path.clone(), accepted.clone());
                let _ = thread::Builder::new().name("retro-client".into()).spawn(move || client(id, stream, &path, tx));
            }
        })
        .map_err(|e| e.to_string())?;
    thread::Builder::new()
        .name("retro-game".into())
        .spawn(move || {
            cpu::fast();
            let mut player = Player::new();
            loop {
                let wait = player.wait();
                match rx.recv_timeout(wait) {
                    Ok(command) => player.command(command),
                    Err(RecvTimeoutError::Timeout) => player.wake(),
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|e| e.to_string())?;
    info!("frames on 127.0.0.1:{}", port);
    Ok(Stream { url, commands: Mutex::new(tx) })
}

static STREAM: OnceLock<Result<Stream, String>> = OnceLock::new();

pub fn url() -> Result<String, String> {
    STREAM.get_or_init(start).as_ref().map(|s| s.url.clone()).map_err(|e| e.clone())
}

pub fn stop() {
    if let Some(Ok(s)) = STREAM.get() {
        let _ = s.commands.lock().unwrap().send(Command::Stop);
    }
}

fn client(id: u32, mut stream: TcpStream, path: &str, tx: Sender<Command>) {
    let request = match ws::request(&mut stream) {
        Ok(r) if r.origin.as_deref() == Some(APP) => r,
        Ok(r) => {
            warn!("refused a connection from {:?}", r.origin);
            return ws::refuse(&mut stream);
        }
        Err(e) => return warn!("worker connection: {}", e),
    };
    let _ = stream.set_nodelay(true);
    // so a stuck worker can't hold up the game
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let base = request.path.split('?').next().unwrap_or("");
    if base == format!("{}/play", path) {
        let options = ws::query(&request.path, "o").and_then(|o| serde_json::from_str(&o).ok());
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nX-Content-Type-Options: nosniff\r\n\
             Cache-Control: no-store\r\nAccess-Control-Allow-Origin: {}\r\nConnection: close\r\n\r\n",
            APP
        );
        match options {
            Some(options) if stream.write_all(head.as_bytes()).is_ok() => {
                let _ = tx.send(Command::Play(stream, options));
            }
            _ => ws::refuse(&mut stream),
        }
        return;
    }
    match request.key {
        Some(key) if base == path => {
            if let Err(e) = ws::upgrade(&mut stream, &key) {
                return warn!("worker connection: {}", e);
            }
        }
        _ => return ws::refuse(&mut stream),
    }
    let reader = match stream.try_clone() {
        Ok(r) => r,
        Err(_) => return,
    };
    if tx.send(Command::Client(id, stream)).is_err() {
        return;
    }
    let mut reader = ws::Reader::new(reader);
    while let Ok(Some((kind, message))) = reader.next() {
        if kind != ws::TEXT {
            continue;
        }
        match serde_json::from_slice(&message) {
            Ok(value) => {
                if tx.send(Command::Message(id, value)).is_err() {
                    return;
                }
            }
            Err(e) => warn!("worker message: {}", e),
        }
    }
    let _ = tx.send(Command::Gone(id));
}

fn buttons(keypad: &mut Keypad, map: &[(u16, u16)]) -> u16 {
    keypad.read();
    map.iter().filter(|(code, _)| keypad.held(*code)).fold(0, |b, (_, bits)| b | bits)
}

fn keymap(m: &Value) -> Vec<(u16, u16)> {
    let pairs = m["keymap"].as_array().map(|a| a.iter().filter_map(Value::as_array)).into_iter().flatten();
    pairs.filter_map(|p| Some((p.first()?.as_u64()? as u16, p.get(1)?.as_u64()? as u16))).collect()
}

fn shift(at: Instant, secs: f64) -> Instant {
    let by = Duration::from_secs_f64(secs.abs());
    if secs >= 0.0 {
        at + by
    } else {
        at.checked_sub(by).unwrap_or(at)
    }
}

fn between(from: Instant, to: Instant) -> f64 {
    if to >= from {
        (to - from).as_secs_f64()
    } else {
        -(from - to).as_secs_f64()
    }
}

fn epoch_now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1e6).unwrap_or(0.0)
}

fn from_epoch(us: f64) -> Instant {
    shift(Instant::now(), (us - epoch_now()) / 1e6)
}

fn to_epoch(at: Instant) -> u64 {
    (epoch_now() + between(Instant::now(), at) * 1e6).max(0.0) as u64
}

fn grid(m: &Value) -> Option<(Instant, f64)> {
    let tick = m["tick"].as_f64()?;
    let period = m["period"].as_f64()? / 1e6;
    if period > 0.004 && period < 0.1 {
        Some((from_epoch(tick), period))
    } else {
        None
    }
}

fn refresh_before(grid: Option<(Instant, f64)>, at: Instant) -> Option<Instant> {
    let (tick, period) = grid?;
    Some(shift(tick, (between(tick, at) / period).floor() * period))
}

#[derive(Default)]
struct Stats {
    since: Option<Instant>,
    wake: Duration,
    frames: u32,
    messages: u32,
    busy: Duration,
    made: u32,
    missed: u32,
    held: u32,
}

#[derive(Clone, Copy, Default)]
struct Target {
    panel: Option<Instant>,
    tick: Option<Instant>,
}

struct Player {
    client: Option<(u32, TcpStream)>,
    out: Option<(u64, TcpStream)>,
    running: bool,
    deadline: Instant,
    target: Target,
    keys: u16,
    fast: bool,
    keypad: Option<Keypad>,
    map: Vec<(u16, u16)>,
    ahead: u32,
    panel: Option<Panel>,
    per: u32,
    grid: Option<(Instant, f64)>,
    margin: f64,
    early: f64,
    work: f64,
    fasting: bool,
    flight: VecDeque<(Instant, bool)>,
    hold: bool,
    fps: f64,
    played: Instant,
    stats: Stats,
    message: Vec<u8>,
    audio: Vec<i16>,
}

impl Player {
    fn new() -> Player {
        Player {
            client: None,
            out: None,
            running: false,
            deadline: Instant::now(),
            target: Target::default(),
            keys: 0,
            fast: false,
            keypad: None,
            map: Vec::new(),
            ahead: 0,
            panel: None,
            per: 1,
            grid: None,
            margin: MARGIN,
            early: EARLY,
            work: 0.004,
            fasting: false,
            flight: VecDeque::new(),
            hold: false,
            fps: 59.7275,
            played: Instant::now(),
            stats: Stats::default(),
            message: Vec::new(),
            audio: Vec::new(),
        }
    }

    fn wait(&self) -> Duration {
        if !self.running {
            return IDLE;
        }
        let until = match self.flight.front() {
            Some(&(refresh, _)) => self.deadline.min(refresh + SEEN),
            None => self.deadline,
        };
        until.saturating_duration_since(Instant::now())
    }

    fn wake(&mut self) {
        let now = Instant::now();
        self.check(now);
        if now >= self.deadline {
            self.picture();
        }
    }

    fn period(&self) -> f64 {
        if let Some(panel) = &self.panel {
            return panel.period() / self.per as f64;
        }
        match self.grid {
            Some((_, t)) if (1.0 / t / self.fps - 1.0).abs() < SYNC_WITHIN => t,
            _ => 1.0 / self.fps,
        }
    }

    fn stop(&mut self) {
        self.running = false;
        self.fast = false;
        self.keypad = None;
        self.panel = None;
        self.flight.clear();
        self.hold = false;
        self.out = None;
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Client(id, stream) => {
                if let Some((_, old)) = self.client.replace((id, stream)) {
                    let _ = old.shutdown(Shutdown::Both);
                }
                self.pause();
                state().frontend.forget_picture();
            }
            Command::Gone(id) => {
                if self.client.as_ref().map_or(false, |(c, _)| *c == id) {
                    self.client = None;
                    self.pause();
                }
            }
            Command::Stop => {
                self.pause();
                self.keys = 0;
            }
            Command::Play(stream, options) => {
                if self.client.is_some() {
                    self.pause();
                    state().frontend.forget_picture();
                    self.out = Some((options["session"].as_u64().unwrap_or(0), stream));
                    self.play(&options);
                }
            }
            Command::Message(id, m) => {
                if self.client.as_ref().map_or(true, |(c, _)| *c != id) {
                    return;
                }
                if let Some(keys) = m["keys"].as_u64() {
                    self.keys = keys as u16;
                }
                if let Some(fast) = m["fast"].as_bool() {
                    self.fast = fast;
                }
                if let Some(session) = m["pause"].as_u64() {
                    if self.out.as_ref().map_or(false, |(s, _)| *s == session) {
                        self.pause();
                    }
                }
                if let Some(sync) = m.get("sync") {
                    self.sync(sync);
                }
            }
        }
    }

    fn play(&mut self, m: &Value) {
        self.fps = match state().frontend.timing() {
            Some((fps, _)) => fps,
            None => return self.pause(),
        };
        if let Some(g) = grid(m) {
            self.grid = Some(g);
        }
        self.map = keymap(m);
        self.ahead = (m["ahead"].as_u64().unwrap_or(0) as u32).min(AHEAD_MAX);
        self.keypad = match Keypad::open() {
            Ok(k) => Some(k),
            Err(e) => {
                warn!("the keys come from the app: {}", e);
                None
            }
        };
        self.per = 1;
        self.panel = match Panel::open() {
            Ok(panel) => {
                let frames = self.fps * panel.period();
                let n = frames.round().max(1.0);
                if (n / frames - 1.0).abs() < SYNC_WITHIN {
                    self.per = n as u32;
                    Some(panel)
                } else {
                    warn!("the panel's {:.2} Hz doesn't fit the game's frames", 1.0 / panel.period());
                    None
                }
            }
            Err(e) => {
                warn!("pictures at the game's pace: {}", e);
                None
            }
        };
        self.flight.clear();
        self.hold = false;
        self.played = Instant::now();
        self.stats = Stats::default();
        self.running = true;
        let now = Instant::now();
        self.target = Target::default();
        self.deadline = now;
        self.plan(now);
    }

    fn pause(&mut self) {
        if self.out.is_some() {
            self.message.clear();
            self.message.resize(PREFIX + FRAME_HEADER, 0);
            let m = &mut self.message[PREFIX..];
            m[0] = KIND_FRAME;
            m[1] = PAUSED;
            self.send();
        }
        if self.running {
            state().flush_save();
        }
        self.stop();
    }

    fn sync(&mut self, sync: &Value) {
        if let Some(g) = grid(sync) {
            self.grid = Some(g);
        }
        if !self.running || self.fasting {
            return;
        }
        let leads = sync["leads"].as_array().map(|l| l.iter().filter_map(Value::as_f64)).into_iter().flatten();
        for lead in leads {
            self.early += if lead / 1e6 < LEAD { EARLIER } else { -LATER };
        }
        self.early = self.early.max(EARLY_MIN).min(EARLY_MAX);
    }

    fn check(&mut self, now: Instant) {
        let panel = match self.panel.as_ref() {
            Some(p) => p,
            None => return self.flight.clear(),
        };
        let period = Duration::from_secs_f64(panel.period());
        let mut retired = None;
        while let Some(&(refresh, fast)) = self.flight.front() {
            if refresh + SEEN > now {
                break;
            }
            self.flight.pop_front();
            if now + SEEN > refresh + period {
                continue;
            }
            let retired = *retired.get_or_insert_with(|| panel.retired());
            if retired.map_or(false, |r| r + SEEN >= refresh) {
                self.margin = (self.margin - MARGIN_DECAY).max(MARGIN_MIN);
                self.stats.made += 1;
            } else {
                if !fast {
                    self.margin = (self.margin + MARGIN_STEP).min(MARGIN_MAX);
                }
                self.hold = true;
                self.stats.missed += 1;
            }
        }
    }

    fn plan(&mut self, now: Instant) {
        let early = self.early + if self.fasting { FAST_SHARE * self.period() * self.per as f64 } else { 0.0 };
        let (grid, margin, last) = (self.grid, self.margin, self.target);
        if let Some(panel) = self.panel.as_mut() {
            let period = panel.period();
            let after = last.panel.map_or(now, |r| shift(r, period / 2.0).max(now));
            match panel.next(after) {
                Some(mut refresh) => loop {
                    let tick = refresh_before(grid, shift(refresh, -margin));
                    let start = shift(tick.unwrap_or(refresh), -early - tick.map_or(margin, |_| 0.0));
                    if start >= now {
                        self.target = Target { panel: Some(refresh), tick };
                        self.deadline = start;
                        return;
                    }
                    refresh = shift(refresh, period);
                },
                None => {
                    warn!("the panel's vsync stopped: pictures at the game's pace");
                    self.panel = None;
                    self.per = 1;
                    self.flight.clear();
                }
            }
        }
        let period = self.period();
        if let Some((_, t)) = grid.filter(|&(_, t)| t == period) {
            let after = last.tick.map_or(now, |r| shift(r, t / 2.0).max(now));
            let mut tick = refresh_before(grid, shift(after, t)).unwrap_or(after);
            while shift(tick, -early) < now {
                tick = shift(tick, t);
            }
            self.target = Target { panel: None, tick: Some(tick) };
            self.deadline = shift(tick, -early);
            return;
        }
        self.target = Target::default();
        self.deadline = shift(self.deadline, period);
        if now > shift(self.deadline, period * BEHIND as f64) {
            self.deadline = now;
        }
    }

    fn held(&mut self) -> u16 {
        match self.keypad.as_mut() {
            Some(k) => buttons(k, &self.map),
            None => self.keys,
        }
    }

    fn frames(&mut self, f: &mut Frontend, fast: bool, started: Instant) -> u32 {
        let period = self.period();
        self.audio.clear();
        if fast {
            let budget = Duration::from_secs_f64(period * self.per as f64 * FAST_SHARE);
            let until = self.target.tick.map_or(started + budget, |t| shift(t, self.work - self.early));
            let mut each = Duration::from_secs_f64(self.work / (self.per + self.ahead) as f64);
            let mut frames = 0;
            loop {
                let at = Instant::now();
                let last = frames + 1 >= FAST_MAX || at + each * 2 >= until;
                let keys = self.held();
                f.frame(keys, if last { Some(1) } else { None });
                frames += 1;
                each = at.elapsed();
                if last {
                    break;
                }
            }
            f.audio(&mut self.audio);
            self.audio.clear();
            return frames;
        }
        let total = self.per + self.ahead;
        let slot = move |i: u32| {
            if i + 1 == total {
                Some(1)
            } else if i + 2 == total {
                Some(0)
            } else {
                None
            }
        };
        for i in 0..self.per {
            let keys = self.held();
            f.frame(keys, slot(i));
        }
        f.audio(&mut self.audio);
        if self.ahead > 0 {
            let keys = self.held();
            if f.ahead() {
                for i in self.per..total {
                    f.frame(keys, slot(i));
                }
                f.back();
            } else {
                warn!("no run-ahead: the core didn't save its state");
                self.ahead = 0;
            }
        }
        self.per
    }

    fn picture(&mut self) {
        let started = Instant::now();
        self.stats.wake = self.stats.wake.max(started.saturating_duration_since(self.deadline));
        let target = self.target;
        let fast = match self.keypad.as_ref() {
            Some(k) => k.held(FAST_KEY),
            None => self.fast,
        };

        let mut guard = state();
        let s = &mut *guard;
        if !s.frontend.loaded() {
            drop(guard);
            self.stop();
            return;
        }
        let frames = self.frames(&mut s.frontend, fast, started);
        self.fasting = fast;

        self.message.clear();
        self.message.resize(PREFIX + FRAME_HEADER, 0);
        let (width, height, top, rows) = s.frontend.picture(&mut self.message, !fast);
        drop(guard);

        let samples = if fast { 0 } else { self.audio.len() / 2 };
        self.message.reserve(samples * 8);
        for c in 0..2 {
            for frame in self.audio.chunks_exact(2).take(samples) {
                self.message.extend_from_slice(&(frame[c] as f32 / 32768.0).to_le_bytes());
            }
        }
        let work = started.elapsed();
        if !fast {
            self.work += (work.as_secs_f64() - self.work) / 16.0;
        }

        let hold = std::mem::take(&mut self.hold) && rows > 0;
        let m = &mut self.message[PREFIX..];
        m[0] = KIND_FRAME;
        m[1] = if hold { HOLD } else { 0 };
        m[2..4].copy_from_slice(&(width as u16).to_le_bytes());
        m[4..6].copy_from_slice(&(height as u16).to_le_bytes());
        m[6..8].copy_from_slice(&(top as u16).to_le_bytes());
        m[8..10].copy_from_slice(&(rows as u16).to_le_bytes());
        m[10..12].copy_from_slice(&(frames as u16).to_le_bytes());
        m[12..16].copy_from_slice(&(samples as u32).to_le_bytes());
        m[16..20].copy_from_slice(&(work.as_micros() as u32).to_le_bytes());
        m[20..24].copy_from_slice(&(self.played.elapsed().as_micros() as u32).to_le_bytes());
        m[24..32].copy_from_slice(&target.tick.map_or(0, to_epoch).to_le_bytes());
        self.send();
        if hold {
            self.stats.held += 1;
        } else if let (true, Some(refresh)) = (rows > 0, target.panel) {
            self.flight.push_back((refresh, fast));
        }
        self.count(frames, work);
        if self.running {
            self.plan(Instant::now());
        }
    }

    fn send(&mut self) {
        let len = (self.message.len() - PREFIX) as u32;
        self.message[..PREFIX].copy_from_slice(&len.to_le_bytes());
        let gone = match self.out.as_mut() {
            Some((_, stream)) => stream.write_all(&self.message).is_err(),
            None => true,
        };
        if gone {
            self.stop();
        }
    }

    fn count(&mut self, frames: u32, work: Duration) {
        let now = Instant::now();
        let st = &mut self.stats;
        let since = *st.since.get_or_insert(now);
        st.frames += frames;
        st.messages += 1;
        st.busy += work;
        if st.frames >= STATS_EVERY {
            let secs = (now - since).as_secs_f64();
            let panel = match &self.panel {
                Some(p) => format!(
                    "the panel's {:.3} Hz, {} frames a picture: {} pictures made their refresh, {} missed it, \
                     {} weren't drawn; compositor refresh {:.1} ms before the panel's at the least, frames \
                     {:.1} ms before that",
                    1.0 / p.period(),
                    self.per,
                    st.made,
                    st.missed,
                    st.held,
                    self.margin * 1000.0,
                    self.early * 1000.0
                ),
                None => "without the panel".into(),
            };
            info!(
                "{} frames in {:.1} s ({:.2} a second) in {} pictures, {:.2} ms of emulation a frame with {} \
                 of run-ahead, keys from {}, {}, compositor {:.3} Hz, woke up to {:.1} ms late",
                st.frames,
                secs,
                st.frames as f64 / secs,
                st.messages,
                st.busy.as_secs_f64() * 1000.0 / st.frames as f64,
                self.ahead,
                if self.keypad.is_some() { "the keypad" } else { "the app" },
                panel,
                self.grid.map_or(0.0, |(_, t)| 1.0 / t),
                st.wake.as_secs_f64() * 1000.0
            );
            self.stats = Stats { since: Some(now), ..Stats::default() };
        }
    }
}
