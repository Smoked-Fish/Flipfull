use crate::clock;
use crate::keypad::Keypad;
use crate::libretro::Game;
use crate::pacer::{between, shift, Pacer};
use crate::panel::Panel;
use crate::service::{self, State};
use crate::settings;
use crate::sound_rate::SoundRate;
use crate::wire::{Grid, Header, Message, PlayOptions, SyncReport, WorkerMessage, HOLD};
use log::{info, warn};
use std::io::Write;
use std::net::{Shutdown, TcpStream};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FAST_MAX: u32 = 20;
const FAST_KEY: u16 = 158;
const CLOCK_EVERY: u32 = 30;
const IDLE: Duration = Duration::from_secs(3600);
const STATS_EVERY: u32 = 1800;

fn epoch_us() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1e6).unwrap_or(0.0)
}

pub enum Command {
    Client(u32, TcpStream),
    Gone(u32),
    Message(u32, WorkerMessage),
    Play(TcpStream, PlayOptions),
    Stop,
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
            Some(k) => {
                k.read();
                self.settings.keymap.iter().filter(|(code, _)| k.held(*code)).fold(0, |b, (_, bits)| b | bits)
            }
            None => app,
        }
    }

    fn fast(&self, app: bool) -> bool {
        self.keypad.as_ref().map_or(app, |k| k.held(FAST_KEY))
    }
}

pub struct Player {
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
    pub fn new() -> Player {
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

    fn compositor(&self, grid: Option<Grid>) -> Option<(Instant, f64)> {
        grid.map(|g| (shift(Instant::now(), (g.tick_us - epoch_us()) / 1e6), g.period_us / 1e6))
    }

    fn to_epoch(&self, at: Instant) -> u64 {
        (epoch_us() + between(Instant::now(), at) * 1e6).max(0.0) as u64
    }

    pub fn wait(&self) -> Duration {
        match self.play {
            Some(_) => self.pacer.until().saturating_duration_since(Instant::now()),
            None => IDLE,
        }
    }

    pub fn wake(&mut self) {
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

    pub fn command(&mut self, command: Command) {
        match command {
            Command::Client(id, connection) => {
                if let Some((_, old)) = self.client.replace((id, connection)) {
                    let _ = old.shutdown(Shutdown::Both);
                }
                self.pause();
                service::state().frontend.forget_picture();
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
            Command::Play(out, options) => {
                if self.client.is_some() {
                    self.pause();
                    service::state().frontend.forget_picture();
                    self.play(out, &options);
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
        let game = service::state().game.as_ref().map(|g| g.info);
        let Game { fps, rate, platform, .. } = match game {
            Some(game) => game,
            None => {
                let _ = out.write_all(self.message.paused());
                return;
            }
        };
        let settings = settings::play(platform);
        let grid = self.compositor(options.grid());
        self.pacer.compositor(grid);
        let keypad = match Keypad::open() {
            Ok(k) => Some(k),
            Err(e) => {
                warn!("the keys come from the app: {}", e);
                None
            }
        };
        self.sound.start(options.rate, settings.latency);
        let now = Instant::now();
        let stats = Stats::default();
        self.play = Some(Play { session: options.session, out, settings, keypad, rate, clock_in: 0, played: now, stats });
        let panel = Panel::open();
        self.pacer.start(fps, panel, now);
    }

    fn pause(&mut self) {
        if let Some(mut play) = self.play.take() {
            let _ = play.out.write_all(self.message.paused());
            service::state().flush_save();
        }
        self.stop();
    }

    fn sync(&mut self, sync: &SyncReport) {
        let grid = self.compositor(sync.grid());
        self.pacer.compositor(grid);
        if self.play.is_none() {
            return;
        }
        if let (Some(s), false) = (sync.sound, self.pacer.fasting()) {
            self.sound.sync(s);
        }
        self.pacer.leads(sync.leads.iter().copied());
    }

    fn frames(&mut self, play: &mut Play, core: &mut State, fast: bool, started: Instant) -> u32 {
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
                core.frontend.frame(keys, if last { Some(1) } else { None });
                frames += 1;
                each = Instant::now().saturating_duration_since(at);
                if last {
                    break;
                }
            }
            core.frontend.audio(&mut self.audio);
            self.audio.clear();
            return frames;
        }
        core.frontend.set_audio_rate(self.sound.rate(self.pacer.fps(), period, play.rate));
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
            core.frontend.frame(keys, slot(i));
        }
        core.frontend.audio(&mut self.audio);
        if ahead > 0 {
            let keys = play.held(self.keys);
            if core.frontend.ahead() {
                for i in per..total {
                    core.frontend.frame(keys, slot(i));
                }
                core.frontend.back();
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

        let mut core = service::state();
        if core.game.is_none() {
            drop(core);
            let _ = play.out.write_all(self.message.paused());
            return self.stop();
        }
        if play.clock_in == 0 {
            play.clock_in = CLOCK_EVERY;
            core.frontend.set_utc_offset(clock::utc_offset());
        }
        play.clock_in -= 1;
        let frames = self.frames(&mut play, &mut core, fast, started);
        let mix = play.settings.mix && !fast;
        let (width, height, top, rows) = core.frontend.picture(self.message.picture(), mix, play.settings.colors);
        let State { frontend, game, .. } = &mut *core;
        if let Some(g) = game.as_mut() {
            g.save.check(frontend.save_data(false), started);
        }
        drop(core);

        let samples = if self.sound.on() && !fast { self.message.sound(&self.audio) } else { 0 };
        play.stats.samples += samples;
        let work = Instant::now().saturating_duration_since(started);

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
            sent_us: Instant::now().saturating_duration_since(play.played).as_micros() as u32,
            tick_us: target.tick.map_or(0, |t| self.to_epoch(t)),
        };
        if play.out.write_all(self.message.finish(&header)).is_err() {
            return self.stop();
        }
        self.count(&mut play, frames, work);
        self.play = Some(play);
        let now = Instant::now();
        self.pacer.plan(now);
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
