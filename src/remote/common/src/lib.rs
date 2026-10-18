use log::{LevelFilter, Log, Metadata, Record};
use nix::sys::socket::{recvmsg, sendmsg, ControlMessage, ControlMessageOwned, MsgFlags};
use nix::sys::uio::IoVec;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

fn toolbox(timeout: Option<Duration>) -> Result<UnixStream, String> {
    let stream = UnixStream::connect(format!("{}/run/toolbox.sock", USERINIT))
        .map_err(|_| "Flipfull's toolbox service isn't running".to_string())?;
    stream
        .set_read_timeout(timeout)
        .and_then(|_| stream.set_write_timeout(timeout))
        .map_err(|e| e.to_string())?;
    Ok(stream)
}

pub fn run(words: &str, timeout: Duration) -> Result<(bool, String), String> {
    let mut stream = toolbox(Some(timeout))?;
    let mut answer = String::new();
    stream
        .write_all(format!("{}\n", words).as_bytes())
        .and_then(|_| stream.read_to_string(&mut answer))
        .map_err(|e| e.to_string())?;
    match answer.split_once('\n') {
        Some(("ok", text)) => Ok((true, text.to_string())),
        Some(("error", text)) => Ok((false, text.to_string())),
        _ => Err("toolboxd's answer made no sense".into()),
    }
}

pub fn record(file: &File) -> Result<UnixStream, String> {
    let stream = toolbox(None)?;
    sendmsg(
        stream.as_raw_fd(),
        &[IoVec::from_slice(b"record\n")],
        &[ControlMessage::ScmRights(&[file.as_raw_fd()])],
        MsgFlags::empty(),
        None,
    )
        .map_err(|e| e.to_string())?;
    Ok(stream)
}

fn receive_file(words: &str, what: &str) -> Result<File, String> {
    let mut stream = toolbox(Some(Duration::from_secs(10)))?;
    stream.write_all(format!("{}\n", words).as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 256];
    let mut space = nix::cmsg_space!([RawFd; 1]);
    let iov = [IoVec::from_mut_slice(&mut buf)];
    let msg = recvmsg(stream.as_raw_fd(), &iov, Some(&mut space), MsgFlags::MSG_CMSG_CLOEXEC)
        .map_err(|e| e.to_string())?;
    let fd = msg.cmsgs().find_map(|c| match c {
        ControlMessageOwned::ScmRights(fds) => fds.first().copied(),
        _ => None,
    });
    let got = msg.bytes;
    match fd {
        Some(fd) => Ok(unsafe { File::from_raw_fd(fd) }),
        None => {
            let mut answer = String::from_utf8_lossy(&buf[..got]).into_owned();
            let _ = stream.read_to_string(&mut answer);
            Err(answer.lines().nth(1).map_or_else(|| format!("toolboxd sent no {}", what), str::to_string))
        }
    }
}

pub fn keypad() -> Result<File, String> {
    receive_file("keypad", "keypad")
}
