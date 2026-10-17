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
const FRAME_HEADER: usize = 16;
const FAST_MAX: u32 = 20;
const BEHIND: f64 = 4.0;
const IDLE: Duration = Duration::from_secs(3600);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);

enum Command {
    Client(u32, TcpStream),
    Gone(u32),
    Message(u32, Value),
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
    match request.key {
        Some(key) if request.path == path => {
            if let Err(e) = ws::upgrade(&mut stream, &key) {
                return warn!("worker connection: {}", e);
            }
        }
        _ => return ws::refuse(&mut stream),
    }
    let _ = stream.set_nodelay(true);
    // so a stuck worker can't hold up the game
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
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

struct Player {
    client: Option<(u32, TcpStream)>,
    running: bool,
    deadline: Instant,
    period: f64,
    keys: u16,
    fast: bool,
    message: Vec<u8>,
    audio: Vec<i16>,
}

impl Player {
    fn new() -> Player {
        Player {
            client: None,
            running: false,
            deadline: Instant::now(),
            period: 1.0 / 59.7275,
            keys: 0,
            fast: false,
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
            self.frame();
        }
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Client(id, stream) => {
                if let Some((_, old)) = self.client.replace((id, stream)) {
                    let _ = old.shutdown(Shutdown::Both);
                }
                self.running = false;
                frontend().forget_picture();
            }
            Command::Gone(id) => {
                if self.client.as_ref().map_or(false, |(c, _)| *c == id) {
                    self.client = None;
                    self.running = false;
                }
            }
            Command::Stop => {
                self.running = false;
                self.keys = 0;
                self.fast = false;
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
                if m["play"].as_bool() == Some(true) {
                    self.play();
                }
                if m["pause"].as_bool() == Some(true) {
                    self.pause();
                }
            }
        }
    }

    fn play(&mut self) {
        let fps = match frontend().timing() {
            Some((fps, _)) => fps,
            None => return,
        };
        self.period = 1.0 / fps;
        self.running = true;
        self.deadline = Instant::now();
    }

    fn pause(&mut self) {
        if self.running {
            self.message.clear();
            self.message.resize(ws::HEADER + FRAME_HEADER, 0);
            let m = &mut self.message[ws::HEADER..];
            m[0] = KIND_FRAME;
            m[1] = PAUSED;
            self.send();
        }
        self.running = false;
    }

    fn frame(&mut self) {
        let mut f = frontend();
        if !f.loaded() {
            drop(f);
            self.running = false;
            return;
        }
        let started = Instant::now();
        let mut frames = 1;
        f.frame(self.keys);
        if self.fast {
            let until = started + Duration::from_secs_f64(self.period * 0.75);
            let mut each = started.elapsed();
            while frames < FAST_MAX && Instant::now() + each < until {
                let at = Instant::now();
                f.frame(self.keys);
                frames += 1;
                each = at.elapsed();
            }
        }
        self.message.clear();
        self.message.resize(ws::HEADER + FRAME_HEADER, 0);
        let (width, height, top, rows) = f.picture(&mut self.message);
        self.audio.clear();
        f.audio(&mut self.audio);
        drop(f);

        let samples = if self.fast { 0 } else { self.audio.len() / 2 };
        self.message.reserve(samples * 8);
        for c in 0..2 {
            for frame in self.audio.chunks_exact(2).take(samples) {
                self.message.extend_from_slice(&(frame[c] as f32 / 32768.0).to_le_bytes());
            }
        }
        let m = &mut self.message[ws::HEADER..];
        m[0] = KIND_FRAME;
        m[2..4].copy_from_slice(&(width as u16).to_le_bytes());
        m[4..6].copy_from_slice(&(height as u16).to_le_bytes());
        m[6..8].copy_from_slice(&(top as u16).to_le_bytes());
        m[8..10].copy_from_slice(&(rows as u16).to_le_bytes());
        m[10..12].copy_from_slice(&(frames as u16).to_le_bytes());
        m[12..16].copy_from_slice(&(samples as u32).to_le_bytes());
        self.send();

        let period = Duration::from_secs_f64(self.period);
        self.deadline += period;
        let now = Instant::now();
        if now > self.deadline + period.mul_f64(BEHIND) {
            self.deadline = now;
        }
    }

    fn send(&mut self) {
        let start = ws::frame(&mut self.message, ws::BINARY);
        let gone = match self.client.as_mut() {
            Some((_, stream)) => stream.write_all(&self.message[start..]).is_err(),
            None => true,
        };
        if gone {
            self.running = false;
        }
    }
}
