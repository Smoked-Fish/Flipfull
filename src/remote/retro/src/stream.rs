use crate::keypad::Keypad;
use crate::libretro::Frontend;
use crate::panel::Panel;
use crate::service::frontend;
use crate::ws;
use log::{info, warn};
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const APP: &str = "http://retro.localhost";

const KIND_FRAME: u8 = 1;
const PAUSED: u8 = 2;
const FRAME_HEADER: usize = 24;
const PREFIX: usize = 4;

const SYNC_WITHIN: f64 = 0.015;
const BEFORE: f64 = 0.045;
const FAST_MAX: u32 = 20;
const FAST_SHARE: f64 = 0.75;
const FAST_KEY: u16 = 158;
const AHEAD_MAX: u32 = 2;
const BEHIND: u32 = 4;
const IDLE: Duration = Duration::from_secs(3600);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);

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

struct Player {
    client: Option<(u32, TcpStream)>,
    out: Option<(u64, TcpStream)>,
    running: bool,
    deadline: Instant,
    refresh: Option<Instant>,
    keys: u16,
    fast: bool,
    keypad: Option<Keypad>,
    map: Vec<(u16, u16)>,
    ahead: u32,
    panel: Option<Panel>,
    per: u32,
    fps: f64,
    played: Instant,
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
            refresh: None,
            keys: 0,
            fast: false,
            keypad: None,
            map: Vec::new(),
            ahead: 0,
            panel: None,
            per: 1,
            fps: 59.7275,
            played: Instant::now(),
            message: Vec::new(),
            audio: Vec::new(),
        }
    }

    fn wait(&self) -> Duration {
        if !self.running {
            return IDLE;
        }
        self.deadline.saturating_duration_since(Instant::now())
    }

    fn wake(&mut self) {
        if Instant::now() >= self.deadline {
            self.picture();
        }
    }

    fn period(&self) -> f64 {
        match &self.panel {
            Some(panel) => panel.period() / self.per as f64,
            None => 1.0 / self.fps,
        }
    }

    fn stop(&mut self) {
        self.running = false;
        self.fast = false;
        self.keypad = None;
        self.panel = None;
        self.out = None;
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Client(id, stream) => {
                if let Some((_, old)) = self.client.replace((id, stream)) {
                    let _ = old.shutdown(Shutdown::Both);
                }
                self.pause();
                frontend().forget_picture();
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
                    frontend().forget_picture();
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
            }
        }
    }

    fn play(&mut self, m: &Value) {
        self.fps = match frontend().timing() {
            Some((fps, _)) => fps,
            None => return self.pause(),
        };
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
        self.played = Instant::now();
        self.running = true;
        let now = Instant::now();
        self.refresh = None;
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
        self.stop();
    }

    fn plan(&mut self, now: Instant) {
        if let Some(panel) = self.panel.as_mut() {
            let period = panel.period();
            let after = self.refresh.map_or(now, |r| shift(r, period / 2.0).max(now));
            match panel.next(after) {
                Some(mut refresh) => loop {
                    let start = shift(refresh, -BEFORE);
                    if start >= now {
                        self.refresh = Some(refresh);
                        self.deadline = start;
                        return;
                    }
                    refresh = shift(refresh, period);
                },
                None => {
                    warn!("the panel's vsync stopped: pictures at the game's pace");
                    self.panel = None;
                    self.per = 1;
                }
            }
        }
        let period = self.period();
        self.refresh = None;
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
        self.audio.clear();
        if fast {
            let until = started + Duration::from_secs_f64(self.period() * self.per as f64 * FAST_SHARE);
            let mut each = Duration::from_secs(0);
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
        let fast = match self.keypad.as_ref() {
            Some(k) => k.held(FAST_KEY),
            None => self.fast,
        };
        let mut f = frontend();
        if !f.loaded() {
            drop(f);
            self.stop();
            return;
        }
        let frames = self.frames(&mut f, fast, started);
        self.message.clear();
        self.message.resize(PREFIX + FRAME_HEADER, 0);
        let (width, height, top, rows) = f.picture(&mut self.message, !fast);
        drop(f);

        let samples = if fast { 0 } else { self.audio.len() / 2 };
        self.message.reserve(samples * 8);
        for c in 0..2 {
            for frame in self.audio.chunks_exact(2).take(samples) {
                self.message.extend_from_slice(&(frame[c] as f32 / 32768.0).to_le_bytes());
            }
        }
        let work = started.elapsed();
        let m = &mut self.message[PREFIX..];
        m[0] = KIND_FRAME;
        m[2..4].copy_from_slice(&(width as u16).to_le_bytes());
        m[4..6].copy_from_slice(&(height as u16).to_le_bytes());
        m[6..8].copy_from_slice(&(top as u16).to_le_bytes());
        m[8..10].copy_from_slice(&(rows as u16).to_le_bytes());
        m[10..12].copy_from_slice(&(frames as u16).to_le_bytes());
        m[12..16].copy_from_slice(&(samples as u32).to_le_bytes());
        m[16..20].copy_from_slice(&(work.as_micros() as u32).to_le_bytes());
        m[20..24].copy_from_slice(&(self.played.elapsed().as_micros() as u32).to_le_bytes());
        self.send();
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
}
