use crate::clock;
use crate::cpu;
use crate::keypad::Keypad;
use crate::libretro::Game;
use crate::pacer::{between, shift, Pacer};
use crate::panel::Panel;
use crate::service::{state, State};
use crate::settings;
use crate::sound_rate::SoundRate;
use crate::wire::{Grid, Header, Message, PlayOptions, SyncReport, WorkerMessage, HOLD};
use crate::ws;
use log::{info, warn};
use std::fs::File;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const APP: &str = "http://retro.localhost";

const FAST_MAX: u32 = 20;
const FAST_KEY: u16 = 158;
const CLOCK_EVERY: u32 = 30;
const IDLE: Duration = Duration::from_secs(3600);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const STATS_EVERY: u32 = 1800;

enum Command {
    Client(u32, TcpStream),
    Gone(u32),
    Message(u32, WorkerMessage),
    Play(TcpStream, PlayOptions),
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
        let options = ws::query(&request.path, "o").and_then(|o| PlayOptions::parse(&o));
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
        match WorkerMessage::parse(&message) {
            Ok(m) => {
                if tx.send(Command::Message(id, m)).is_err() {
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

fn epoch_now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1e6).unwrap_or(0.0)
}

fn from_epoch(us: f64) -> Instant {
    shift(Instant::now(), (us - epoch_now()) / 1e6)
}

fn to_epoch(at: Instant) -> u64 {
    (epoch_now() + between(Instant::now(), at) * 1e6).max(0.0) as u64
}

fn compositor(grid: Option<Grid>) -> Option<(Instant, f64)> {
    grid.map(|g| (from_epoch(g.tick_us), g.period_us / 1e6))
}

#[derive(Default)]
struct Stats {
    since: Option<Instant>,
    wake: Duration,
    samples: usize,
    frames: u32,
    messages: u32,
    busy: Duration,
}

struct Play {
    session: u64,
    out: TcpStream,
    settings: settings::Play,
    keypad: Option<Keypad>,
    rate: f64,
    clock_in: u32,
    played: Instant,
    stats: Stats,
}

impl Play {
    fn held(&mut self, app: u16) -> u16 {
        match self.keypad.as_mut() {
            Some(k) => buttons(k, &self.settings.keymap),
            None => app,
        }
    }

    fn fast(&self, app: bool) -> bool {
        self.keypad.as_ref().map_or(app, |k| k.held(FAST_KEY))
    }
}

struct Player {
    client: Option<(u32, TcpStream)>,
    keys: u16,
    fast: bool,
    play: Option<Play>,
    pacer: Pacer,
    sound: SoundRate,
    message: Message,
    audio: Vec<i16>,
}

impl Player {
    fn new() -> Player {
        Player {
            client: None,
            keys: 0,
            fast: false,
            play: None,
            pacer: Pacer::new(),
            sound: SoundRate::new(),
            message: Message::default(),
            audio: Vec::new(),
        }
    }

    fn wait(&self) -> Duration {
        match self.play {
            Some(_) => self.pacer.until().saturating_duration_since(Instant::now()),
            None => IDLE,
        }
    }

    fn wake(&mut self) {
        let now = Instant::now();
        self.pacer.check(now);
        if now >= self.pacer.deadline() {
            self.picture();
        }
    }

    fn stop(&mut self) {
        self.play = None;
        self.fast = false;
        self.pacer.stop();
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
                    self.play(stream, &options);
                }
            }
            Command::Message(id, m) => {
                if self.client.as_ref().map_or(true, |(c, _)| *c != id) {
                    return;
                }
                if let Some(keys) = m.keys {
                    self.keys = keys;
                }
                if let Some(fast) = m.fast {
                    self.fast = fast;
                }
                if let Some(session) = m.pause {
                    if self.play.as_ref().map_or(false, |p| p.session == session) {
                        self.pause();
                    }
                }
                if let Some(sync) = m.sync {
                    self.sync(&sync);
                }
            }
        }
    }

    fn play(&mut self, mut out: TcpStream, options: &PlayOptions) {
        let info = state().game.as_ref().map(|g| g.info);
        let Game { fps, rate, platform, .. } = match info {
            Some(info) => info,
            None => {
                let _ = out.write_all(self.message.paused());
                return;
            }
        };
        let settings = settings::play(platform);
        self.pacer.compositor(compositor(options.grid()));
        let keypad = match Keypad::open() {
            Ok(k) => Some(k),
            Err(e) => {
                warn!("the keys come from the app: {}", e);
                None
            }
        };
        self.sound.start(options.rate, settings.latency);
        let session = options.session;
        let stats = Stats::default();
        self.play = Some(Play { session, out, settings, keypad, rate, clock_in: 0, played: Instant::now(), stats });
        let panel = Panel::open();
        self.pacer.start(fps, panel, Instant::now());
    }

    fn pause(&mut self) {
        if let Some(mut play) = self.play.take() {
            let _ = play.out.write_all(self.message.paused());
            state().flush_save();
        }
        self.stop();
    }

    fn sync(&mut self, sync: &SyncReport) {
        self.pacer.compositor(compositor(sync.grid()));
        if self.play.is_none() {
            return;
        }
        if let (Some(s), false) = (sync.sound, self.pacer.fasting()) {
            self.sound.sync(s);
        }
        self.pacer.leads(sync.leads.iter().copied());
    }

    fn frames(&mut self, play: &mut Play, s: &mut State, fast: bool, started: Instant) -> u32 {
        let (period, per, ahead) = (self.pacer.period(), self.pacer.per(), play.settings.ahead);
        self.audio.clear();
        if fast {
            let until = self.pacer.fast_until(started);
            let most = play.settings.fast.map_or(FAST_MAX, |speed| per * speed);
            let mut each = Duration::from_secs_f64(self.pacer.work() / (per + ahead) as f64);
            let mut frames = 0;
            loop {
                let at = Instant::now();
                let last = frames + 1 >= most || at + each * 2 >= until;
                let keys = play.held(self.keys);
                s.frontend.frame(keys, if last { Some(1) } else { None });
                frames += 1;
                each = at.elapsed();
                if last {
                    break;
                }
            }
            s.frontend.audio(&mut self.audio);
            self.audio.clear();
            return frames;
        }
        s.frontend.set_audio_rate(self.sound.rate(self.pacer.fps(), period, play.rate));
        let (total, mix) = (per + ahead, play.settings.mix);
        let slot = move |i: u32| {
            if i + 1 == total {
                Some(1)
            } else if i + 2 == total && mix {
                Some(0)
            } else {
                None
            }
        };
        for i in 0..per {
            let keys = play.held(self.keys);
            s.frontend.frame(keys, slot(i));
        }
        s.frontend.audio(&mut self.audio);
        if ahead > 0 {
            let keys = play.held(self.keys);
            if s.frontend.ahead() {
                for i in per..total {
                    s.frontend.frame(keys, slot(i));
                }
                s.frontend.back();
            } else {
                warn!("no run-ahead: the core didn't save its state");
                play.settings.ahead = 0;
            }
        }
        per
    }

    fn picture(&mut self) {
        let mut play = match self.play.take() {
            Some(play) => play,
            None => return,
        };
        let started = Instant::now();
        play.stats.wake = play.stats.wake.max(started.saturating_duration_since(self.pacer.deadline()));
        let target = self.pacer.target();
        let fast = play.fast(self.fast);

        let mut guard = state();
        let s = &mut *guard;
        if s.game.is_none() {
            drop(guard);
            return self.stop();
        }
        if play.clock_in == 0 {
            play.clock_in = CLOCK_EVERY;
            s.frontend.set_utc_offset(clock::utc_offset());
        }
        play.clock_in -= 1;
        let frames = self.frames(&mut play, s, fast, started);

        let mix = play.settings.mix && !fast;
        let (width, height, top, rows) = s.frontend.picture(self.message.picture(), mix, play.settings.colors);
        let State { frontend, game, .. } = s;
        if let Some(g) = game.as_mut() {
            g.save.check(frontend.save_data(false), started);
        }
        drop(guard);

        let samples = if self.sound.on() && !fast { self.message.sound(&self.audio) } else { 0 };
        play.stats.samples += samples;
        let work = started.elapsed();

        let hold = self.pacer.made(fast, rows > 0, work.as_secs_f64());
        let header = Header {
            flags: if hold { HOLD } else { 0 },
            width: width as u16,
            height: height as u16,
            top: top as u16,
            rows: rows as u16,
            frames: frames as u16,
            samples: samples as u32,
            work_us: work.as_micros() as u32,
            sent_us: play.played.elapsed().as_micros() as u32,
            tick_us: target.tick.map_or(0, to_epoch),
        };
        if play.out.write_all(self.message.finish(&header)).is_err() {
            return self.stop();
        }
        self.count(&mut play, frames, work);
        self.play = Some(play);
        self.pacer.plan(Instant::now());
    }

    fn count(&mut self, play: &mut Play, frames: u32, work: Duration) {
        let now = Instant::now();
        let st = &mut play.stats;
        let since = *st.since.get_or_insert(now);
        st.frames += frames;
        st.messages += 1;
        st.busy += work;
        if st.frames >= STATS_EVERY {
            let secs = (now - since).as_secs_f64();
            let panel = self.pacer.report();
            info!(
                "{} frames in {:.1} s ({:.2} a second) in {} pictures, {:.2} ms of emulation a frame with {} \
                 of run-ahead{}, keys from {}, {}, compositor {:.3} Hz, sound {:.0} ms ({:.0} samples a second, \
                 rate {:+.2}%), woke up to {:.1} ms late",
                st.frames,
                secs,
                st.frames as f64 / secs,
                st.messages,
                st.busy.as_secs_f64() * 1000.0 / st.frames as f64,
                play.settings.ahead,
                if play.settings.mix { ", frames mixed" } else { "" },
                if play.keypad.is_some() { "the keypad" } else { "the app" },
                panel,
                self.pacer.compositor_hz(),
                self.sound.buffered_ms(),
                st.samples as f64 / secs,
                self.sound.skew() * 100.0,
                st.wake.as_secs_f64() * 1000.0
            );
            play.stats = Stats { since: Some(now), ..Stats::default() };
        }
    }
}
