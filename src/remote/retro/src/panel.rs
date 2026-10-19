use std::fs::File;
use std::os::unix::fs::FileExt;
use std::time::{Duration, Instant};

const DIR: &str = "/sys/class/drm/sde-crtc-0";
const PERIOD: f64 = 1.0 / 30.0;

pub struct Panel {
    vsync: File,
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
        let name = format!("{}/vsync_event", DIR);
        let panel = Panel { vsync: File::open(&name).map_err(|e| format!("{}: {}", name, e))? };
        read(&panel.vsync, "VSYNC=").map(|_| panel).ok_or_else(|| "the panel's vsync isn't there".into())
    }

    pub fn period(&self) -> f64 {
        PERIOD
    }

    pub fn next(&mut self, after: Instant) -> Option<Instant> {
        let last = read(&self.vsync, "VSYNC=")?;
        let since = after.saturating_duration_since(last).as_secs_f64();
        Some(last + Duration::from_secs_f64(((since / PERIOD).floor() + 1.0) * PERIOD))
    }
}
