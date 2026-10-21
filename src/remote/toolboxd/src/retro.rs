use crate::{answer, log};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::io::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::{Component, Path, PathBuf};

const STORAGE: &str = "/data/media";
const GAMES: &[&str] = &["gba", "gbc", "gb"];
const WRITTEN: &[&str] = &["sav", "state", "state1", "state2", "state3", "state4", "state5", "state6", "state7", "state8", "state9"];
const MAX_WRITE: usize = 8 * 1024 * 1024;
const MAX_DEPTH: usize = 6;
const MAX_FILES: usize = 20000;
const MEDIA_RW: u32 = 1023;

// "a\040b" in /proc/mounts is "a b"
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 4 <= b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
            out.push((b[i + 1] - b'0') * 64 + (b[i + 2] - b'0') * 8 + (b[i + 3] - b'0'));
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn storages() -> Vec<(PathBuf, bool)> {
    let mut found = vec![(PathBuf::from(STORAGE), false)];
    if let Ok(mounts) = fs::read_to_string("/proc/mounts") {
        for line in mounts.lines() {
            let mut f = line.split_whitespace();
            if let (Some(dev), Some(dir)) = (f.next(), f.next()) {
                if dev.starts_with("/dev/block/vold/public") {
                    found.push((PathBuf::from(unescape(dir)), true));
                }
            }
        }
    }
    found
}

fn roots() -> Vec<(PathBuf, bool)> {
    let mut roots: Vec<(PathBuf, bool)> = Vec::new();
    for (storage, sd) in storages() {
        let dir = match fs::read_dir(&storage) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for e in dir.flatten() {
            if !e.file_name().to_string_lossy().eq_ignore_ascii_case("roms") {
                continue;
            }
            if let Ok(path) = fs::canonicalize(e.path()) {
                if path.is_dir() && !roots.iter().any(|(r, _)| *r == path) {
                    roots.push((path, sd));
                }
            }
        }
    }
    roots
}

fn extension(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

fn listed(name: &str) -> bool {
    GAMES.contains(&extension(name).as_str())
}

fn readable(name: &str) -> bool {
    listed(name) || WRITTEN.contains(&extension(name).as_str())
}

fn checked(path: &str, may: fn(&str) -> bool) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err(format!("Not a path: {}", path));
    }
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if name.starts_with('.') || !may(&name) {
        return Err(format!("Not a game's file: {}", name));
    }
    let parent = p.parent().and_then(|d| fs::canonicalize(d).ok()).ok_or_else(|| format!("No folder for {}", path))?;
    if !roots().iter().any(|(r, _)| parent.starts_with(r)) {
        return Err(format!("Not in a roms folder: {}", path));
    }
    Ok(parent.join(name))
}

fn walk(dir: &Path, depth: usize, out: &mut String, count: &mut usize) {
    let entries = match fs::read_dir(dir) {
        Ok(d) => d,
        Err(_) => return,
    };
    for e in entries.flatten() {
        if *count >= MAX_FILES {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.contains('\n') || name.contains('\t') {
            continue;
        }
        // don't follow symlinked folders, they can loop
        let meta = match fs::symlink_metadata(e.path()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            if depth < MAX_DEPTH {
                walk(&e.path(), depth + 1, out, count);
            }
        } else if listed(&name) {
            let meta = fs::metadata(e.path()).unwrap_or(meta);
            if meta.is_file() {
                *count += 1;
                out.push_str(&format!("file\t{}\t{}\t{}\n", e.path().display(), meta.len(), meta.mtime()));
            }
        }
    }
}

fn list(stream: &mut UnixStream) {
    let mut out = String::new();
    let mut count = 0;
    for (root, sd) in roots() {
        out.push_str(&format!("root\t{}\t{}\n", root.display(), if sd { "sd" } else { "internal" }));
        walk(&root, 0, &mut out, &mut count);
    }
    answer(stream, true, out.as_bytes())
}

pub fn send_fd(stream: &mut UnixStream, fd: RawFd, what: &str) {
    let mut text = *b"ok\n";
    let mut iov = libc::iovec { iov_base: text.as_mut_ptr() as *mut libc::c_void, iov_len: text.len() };
    let mut control = [0u8; 64];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = unsafe { libc::CMSG_SPACE(std::mem::size_of::<RawFd>() as u32) } as _;
    unsafe {
        let c = libc::CMSG_FIRSTHDR(&msg);
        (*c).cmsg_level = libc::SOL_SOCKET;
        (*c).cmsg_type = libc::SCM_RIGHTS;
        (*c).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<RawFd>() as u32) as _;
        *(libc::CMSG_DATA(c) as *mut RawFd) = fd;
        if libc::sendmsg(stream.as_raw_fd(), &msg, 0) < 0 {
            log(&format!("{}: {}", what, std::io::Error::last_os_error()));
        }
    }
}

pub fn keypad(stream: &mut UnixStream) {
    let device = fs::read_dir("/sys/class/input").ok().and_then(|dir| {
        dir.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).find(|name| {
            name.starts_with("event")
                && fs::read_to_string(format!("/sys/class/input/{}/device/name", name))
                .map_or(false, |n| n.trim().ends_with("matrix_keypad0"))
        })
    });
    match device.map(|d| File::open(format!("/dev/input/{}", d))) {
        Some(Ok(file)) => send_fd(stream, file.as_raw_fd(), "keypad"),
        Some(Err(e)) => answer(stream, false, format!("keypad: {}\n", e).as_bytes()),
        None => answer(stream, false, b"No keypad\n"),
    }
}

fn open(stream: &mut UnixStream, path: &str) {
    let file = checked(path, readable).and_then(|p| {
        OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&p).map_err(|e| format!("{}: {}", path, e))
    });
    match file {
        Ok(file) => send_fd(stream, file.as_raw_fd(), "retro-open"),
        Err(why) => answer(stream, false, format!("{}\n", why).as_bytes()),
    }
}

// written next to it then renamed
fn write(stream: &mut UnixStream, size: usize, path: &str, mut data: Vec<u8>) {
    let written = checked(path, |n| WRITTEN.contains(&extension(n).as_str())).and_then(|p| {
        if size > MAX_WRITE {
            return Err("Too big".to_string());
        }
        if data.len() < size {
            let start = data.len();
            data.resize(size, 0);
            stream.read_exact(&mut data[start..]).map_err(|e| format!("the data: {}", e))?;
        }
        data.truncate(size);
        let mut tmp = p.clone().into_os_string();
        tmp.push(".flipfull-tmp");
        let tmp = PathBuf::from(tmp);
        let done = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o664)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)
            .and_then(|mut f| {
                if p.starts_with(STORAGE) {
                    unsafe { libc::fchown(f.as_raw_fd(), 0, MEDIA_RW) };
                }
                f.write_all(&data)?;
                f.sync_all()
            })
            .and_then(|_| fs::rename(&tmp, &p));
        if let Err(e) = done {
            let _ = fs::remove_file(&tmp);
            return Err(format!("{}: {}", path, e));
        }
        Ok(())
    });
    match written {
        Ok(()) => answer(stream, true, b"\n"),
        Err(why) => {
            log(&format!("retro-write: {}", why));
            answer(stream, false, format!("{}\n", why).as_bytes())
        }
    }
}

pub fn command(stream: &mut UnixStream, line: &str, rest: Vec<u8>) {
    let (verb, args) = line.split_once(' ').unwrap_or((line, ""));
    match verb {
        "keypad" if args.is_empty() => keypad(stream),
        "retro-list" if args.is_empty() => list(stream),
        "retro-open" if !args.is_empty() => open(stream, args),
        "retro-write" => match args.split_once(' ').and_then(|(n, p)| Some((n.parse().ok()?, p))) {
            Some((size, path)) => write(stream, size, path, rest),
            None => answer(stream, false, b"Not a command\n"),
        },
        _ => answer(stream, false, b"Not a command\n"),
    }
}
