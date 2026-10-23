use log::{info, warn};
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Once;
use std::thread;
use std::time::Duration;

const EVERY: Duration = Duration::from_secs(60);

static OFFSET: AtomicI64 = AtomicI64::new(0);

fn ask() -> Result<(i64, String), String> {
    let out = Command::new("/system/bin/date").arg("+%z %Z").output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (z, name) = text.split_once(' ').unwrap_or((&text, ""));
    let b = z.as_bytes();
    if b.len() != 5 || !(b[0] == b'+' || b[0] == b'-') || !b[1..].iter().all(u8::is_ascii_digit) {
        return Err(format!("date said {:?}", text));
    }
    let hours: i64 = z[1..3].parse().unwrap_or(0);
    let minutes: i64 = z[3..5].parse().unwrap_or(0);
    let secs = (hours * 3600 + minutes * 60) * if b[0] == b'-' { -1 } else { 1 };
    Ok((secs, name.to_string()))
}

fn update(first: bool) {
    match ask() {
        Ok((secs, name)) => {
            if first || OFFSET.swap(secs, Ordering::Relaxed) != secs {
                OFFSET.store(secs, Ordering::Relaxed);
                info!("local time is UTC{:+03}:{:02} ({})", secs / 3600, (secs.abs() % 3600) / 60, name);
            }
        }
        Err(e) if first => warn!("no local time, the games' clocks are UTC: {}", e),
        Err(_) => {}
    }
}

pub fn utc_offset() -> i64 {
    static START: Once = Once::new();
    START.call_once(|| {
        update(true);
        let _ = thread::Builder::new().name("retro-clock".into()).spawn(|| loop {
            thread::sleep(EVERY);
            update(false);
        });
    });
    OFFSET.load(Ordering::Relaxed)
}
