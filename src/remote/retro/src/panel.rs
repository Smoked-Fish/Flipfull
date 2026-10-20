use std::fs::File;
use std::os::unix::fs::FileExt;
use std::time::{Duration, Instant};

const DIR: &str = "/sys/class/drm/sde-crtc-0";
const PERIOD: f64 = 1.0 / 30.0;
const NEAR: f64 = 0.05;
const SETTLE: f64 = 0.05;
const STALE: f64 = 4.0;

pub struct Panel {
    vsync: File,
    retire: File,
    last: Option<Instant>,
    period: f64,
}

fn mono_ns() -> i128 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as i128 * 1_000_000_000 + ts.tv_nsec as i128
}

fn instant(ns: u64) -> Instant {
    let now = Instant::now();
    let ago = mono_ns() - ns as i128;
    if ago >= 0 {
        now.checked_sub(Duration::from_nanos(ago as u64)).unwrap_or(now)
    } else {
        now + Duration::from_nanos((-ago) as u64)
    }
}

fn read(file: &File, key: &str) -> Option<Instant> {
    let mut buf = [0u8; 128];
    let n = file.read_at(&mut buf, 0).ok()?;
    let text = std::str::from_utf8(&buf[..n]).ok()?;
    let ns: u64 = text.lines().find_map(|l| l.strip_prefix(key)?.trim().parse().ok())?;
    Some(instant(ns)).filter(|_| ns > 0)
}

impl Panel {
    pub fn open() -> Result<Panel, String> {
        let open = |name: &str| File::open(format!("{}/{}", DIR, name)).map_err(|e| format!("{}/{}: {}", DIR, name, e));
        let mut panel =
            Panel { vsync: open("vsync_event")?, retire: open("retire_frame_event")?, last: None, period: PERIOD };
        panel.update();
        panel.last.map(|_| panel).ok_or_else(|| "the panel's vsync isn't there".into())
    }

    fn update(&mut self) {
        let at = match read(&self.vsync, "VSYNC=") {
            Some(at) => at,
            None => return,
        };
        if let Some(last) = self.last {
            if at <= last {
                return;
            }
            let gap = (at - last).as_secs_f64();
            let n = (gap / self.period).round();
            if n >= 1.0 && n <= 8.0 && ((gap / n) / self.period - 1.0).abs() < NEAR {
                self.period += (gap / n - self.period) * SETTLE;
            }
        }
        self.last = Some(at);
    }

    pub fn period(&self) -> f64 {
        self.period
    }

    pub fn next(&mut self, after: Instant) -> Option<Instant> {
        self.update();
        let last = self.last?;
        if Instant::now().saturating_duration_since(last).as_secs_f64() > self.period * STALE {
            return None;
        }
        let since = after.saturating_duration_since(last).as_secs_f64();
        Some(last + Duration::from_secs_f64(((since / self.period).floor() + 1.0) * self.period))
    }

    pub fn retired(&self) -> Option<Instant> {
        read(&self.retire, "RETIRE_FRAME_TIME=")
    }
}
