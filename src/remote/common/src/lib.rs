use log::{LevelFilter, Log, Metadata, Record};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use toolbox::{Answer, Request};

pub const USERINIT: &str = "/data/local/userinit";

const LOG_MAX: u64 = 256 * 1024;

struct FileLog {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Log for FileLog {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let line = format!("{} {} {}\n", secs, record.level(), record.args());
        let _guard = self.lock.lock();
        if fs::metadata(&self.path).map(|m| m.len() > LOG_MAX).unwrap_or(false) {
            let _ = fs::rename(&self.path, self.path.with_extension("log.old"));
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = f.write_all(line.as_bytes());
        }
    }

    fn flush(&self) {}
}

pub fn own_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from)).unwrap_or_default()
}

pub fn init_log() {
    let logger = FileLog { path: own_dir().join("daemon.log"), lock: Mutex::new(()) };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
}

pub fn feature_on(id: &str) -> bool {
    fs::read_to_string(format!("{}/state/features", USERINIT))
        .map(|list| list.lines().any(|line| line == id))
        .unwrap_or(false)
}

fn connect(timeout: Option<Duration>) -> Result<UnixStream, String> {
    let stream = UnixStream::connect(format!("{}/run/toolbox.sock", USERINIT))
        .map_err(|_| "Flipfull's toolbox service isn't running".to_string())?;
    stream
        .set_read_timeout(timeout)
        .and_then(|_| stream.set_write_timeout(timeout))
        .map_err(|e| e.to_string())?;
    Ok(stream)
}

pub fn ask(request: &Request, timeout: Option<Duration>) -> Result<Answer, String> {
    toolbox::ask(connect(timeout)?, request)
}
