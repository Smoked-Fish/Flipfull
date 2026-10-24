use crate::panel::Panel;
use log::warn;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

const SYNC_WITHIN: f64 = 0.015;
const LEAD: f64 = 0.0095;
const EARLIER: f64 = 0.001;
const LATER: f64 = 0.00004;
const EARLY: f64 = 0.022;
const EARLY_MIN: f64 = 0.004;
const EARLY_MAX: f64 = 0.05;
const MARGIN: f64 = 0.023;
const MARGIN_MIN: f64 = 0.021;
const MARGIN_MAX: f64 = 0.027;
const MARGIN_STEP: f64 = 0.001;
const MARGIN_DECAY: f64 = 0.00002;
const SEEN: Duration = Duration::from_millis(3);
const FAST_SHARE: f64 = 0.75;
const BEHIND: u32 = 4;

pub fn shift(at: Instant, secs: f64) -> Instant {
    let by = Duration::from_secs_f64(secs.abs());
    if secs >= 0.0 {
        at + by
    } else {
        at.checked_sub(by).unwrap_or(at)
    }
}

pub fn between(from: Instant, to: Instant) -> f64 {
    if to >= from {
        (to - from).as_secs_f64()
    } else {
        -(from - to).as_secs_f64()
    }
}

fn refresh_before(grid: Option<(Instant, f64)>, at: Instant) -> Option<Instant> {
    let (tick, period) = grid?;
    Some(shift(tick, (between(tick, at) / period).floor() * period))
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Target {
    pub panel: Option<Instant>,
    pub tick: Option<Instant>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Counts {
    pub made: u32,
    pub missed: u32,
    pub held: u32,
}

pub struct Pacer {
    panel: Option<Panel>,
    per: u32,
    fps: f64,
    grid: Option<(Instant, f64)>,
    deadline: Instant,
    target: Target,
    margin: f64,
    early: f64,
    work: f64,
    fasting: bool,
    flight: VecDeque<(Instant, bool)>,
    hold: bool,
    counts: Counts,
}

impl Pacer {
    pub fn new() -> Pacer {
        Pacer {
            panel: None,
            per: 1,
            fps: 59.7275,
            grid: None,
            deadline: Instant::now(),
            target: Target::default(),
            margin: MARGIN,
            early: EARLY,
            work: 0.004,
            fasting: false,
            flight: VecDeque::new(),
            hold: false,
            counts: Counts::default(),
        }
    }

    pub fn start(&mut self, fps: f64, panel: Result<Panel, String>, now: Instant) {
        self.fps = fps;
        self.per = 1;
        self.panel = match panel {
            Ok(panel) => {
                let frames = fps * panel.period();
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
        self.counts = Counts::default();
        self.target = Target::default();
        self.deadline = now;
        self.plan(now);
    }

    pub fn stop(&mut self) {
        self.panel = None;
        self.flight.clear();
        self.hold = false;
    }

    pub fn compositor(&mut self, grid: Option<(Instant, f64)>) {
        if let Some(g) = grid {
            self.grid = Some(g);
        }
    }

    pub fn fps(&self) -> f64 {
        self.fps
    }

    pub fn per(&self) -> u32 {
        self.per
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    pub fn target(&self) -> Target {
        self.target
    }

    pub fn fasting(&self) -> bool {
        self.fasting
    }

    pub fn work(&self) -> f64 {
        self.work
    }

    pub fn until(&self) -> Instant {
        match self.flight.front() {
            Some(&(refresh, _)) => self.deadline.min(refresh + SEEN),
            None => self.deadline,
        }
    }

    pub fn period(&self) -> f64 {
        if let Some(panel) = &self.panel {
            return panel.period() / self.per as f64;
        }
        match self.grid {
            Some((_, t)) if (1.0 / t / self.fps - 1.0).abs() < SYNC_WITHIN => t,
            _ => 1.0 / self.fps,
        }
    }

    pub fn leads(&mut self, leads: impl Iterator<Item = f64>) {
        if self.fasting {
            return;
        }
        for lead in leads {
            self.early += if lead / 1e6 < LEAD { EARLIER } else { -LATER };
        }
        self.early = self.early.max(EARLY_MIN).min(EARLY_MAX);
    }

    pub fn check(&mut self, now: Instant) {
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
                self.counts.made += 1;
            } else {
                if !fast {
                    self.margin = (self.margin + MARGIN_STEP).min(MARGIN_MAX);
                }
                self.hold = true;
                self.counts.missed += 1;
            }
        }
    }

    pub fn fast_until(&self, started: Instant) -> Instant {
        let budget = Duration::from_secs_f64(self.period() * self.per as f64 * FAST_SHARE);
        self.target.tick.map_or(started + budget, |t| shift(t, self.work - self.early))
    }

    pub fn made(&mut self, fast: bool, rows: bool, work: f64) -> bool {
        self.fasting = fast;
        if !fast {
            self.work += (work - self.work) / 16.0;
        }
        let hold = std::mem::take(&mut self.hold) && rows;
        if hold {
            self.counts.held += 1;
        } else if let (true, Some(refresh)) = (rows, self.target.panel) {
            self.flight.push_back((refresh, fast));
        }
        hold
    }

    pub fn plan(&mut self, now: Instant) {
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

    pub fn report(&mut self) -> String {
        let c = std::mem::take(&mut self.counts);
        match &self.panel {
            Some(p) => format!(
                "the panel's {:.3} Hz, {} frames a picture: {} pictures made their refresh, {} missed it, \
                 {} weren't drawn; compositor refresh {:.1} ms before the panel's at the least, frames \
                 {:.1} ms before that",
                1.0 / p.period(),
                self.per,
                c.made,
                c.missed,
                c.held,
                self.margin * 1000.0,
                self.early * 1000.0
            ),
            None => "without the panel".into(),
        }
    }

    pub fn compositor_hz(&self) -> f64 {
        self.grid.map_or(0.0, |(_, t)| 1.0 / t)
    }
}
