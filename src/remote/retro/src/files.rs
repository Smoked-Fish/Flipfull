use flipfull_remote::{own_dir, retro_list, retro_open, retro_write};
use log::{info, warn};
use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::AsRawFd;
use std::sync::{Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const GAMES: &[(&str, &str)] = &[("gba", "GBA"), ("gbc", "GBC"), ("gb", "GB")];
pub const BIOS: &[&str] = &["gba_bios.bin", "gb_bios.bin", "gbc_bios.bin", "sgb_bios.bin"];
pub const SLOTS: u32 = 4;
const QUIET: Duration = Duration::from_secs(1);
const AT_MOST: Duration = Duration::from_secs(10);
const RETRIES: u32 = 3;

#[derive(Serialize, Clone)]
pub struct Game {
    pub path: String,
    pub title: String,
    pub system: &'static str,
    pub folder: String,
    pub sd: bool,
}

pub fn games() -> Result<(Vec<Game>, Vec<String>), String> {
    let listing = retro_list()?;
    let mut roots: Vec<(String, bool)> = Vec::new();
    let mut games = Vec::new();
    let mut bios = Vec::new();
    for line in listing.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        match f.as_slice() {
            ["root", path, kind] => roots.push((format!("{}/", path.trim_end_matches('/')), *kind == "sd")),
            ["file", path, _size, _mtime] => {
                let name = path.rsplit('/').next().unwrap_or(path);
                if BIOS.contains(&name.to_ascii_lowercase().as_str()) {
                    bios.push(path.to_string());
                    continue;
                }
                let (stem, ext) = match name.rsplit_once('.') {
                    Some(s) => s,
                    None => continue,
                };
                let system = match GAMES.iter().find(|(e, _)| e.eq_ignore_ascii_case(ext)) {
                    Some(&(_, s)) => s,
                    None => continue,
                };
                let (root, sd) = match roots.iter().find(|(r, _)| path.starts_with(r.as_str())) {
                    Some(r) => r.clone(),
                    None => continue,
                };
                let inside = &path[root.len()..];
                let folder = inside[..inside.len() - name.len()].to_string();
                games.push(Game { path: path.to_string(), title: stem.to_string(), system, folder, sd });
            }
            _ => {}
        }
    }
    Ok((games, bios))
}

pub fn sibling(game: &str, ext: &str) -> String {
    let name_at = game.rfind('/').map_or(0, |i| i + 1);
    match game[name_at..].rfind('.') {
        Some(dot) => format!("{}.{}", &game[..name_at + dot], ext),
        None => format!("{}.{}", game, ext),
    }
}

pub fn state_path(game: &str, slot: u32) -> String {
    sibling(game, &if slot == 0 { "state".to_string() } else { format!("state{}", slot) })
}

pub fn read(path: &str) -> Result<Vec<u8>, String> {
    let mut file = retro_open(path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).map_err(|e| format!("{}: {}", path, e))?;
    Ok(data)
}

pub fn modified(path: &str) -> Option<i64> {
    retro_open(path).ok()?.metadata().ok().map(|m| m.mtime())
}

pub struct Rom {
    ptr: *mut libc::c_void,
    len: usize,
}

impl Rom {
    pub fn open(path: &str) -> Result<Rom, String> {
        let file = retro_open(path)?;
        let len = file.metadata().map_err(|e| e.to_string())?.len() as usize;
        if len == 0 {
            return Err("the file is empty".into());
        }
        let ptr = unsafe { libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ, libc::MAP_PRIVATE, file.as_raw_fd(), 0) };
        if ptr == libc::MAP_FAILED {
            return Err(format!("{}: {}", path, std::io::Error::last_os_error()));
        }
        Ok(Rom { ptr, len })
    }

    pub fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr as *const u8, self.len) }
    }
}

impl Drop for Rom {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.ptr, self.len) };
    }
}

pub fn copy_bios(found: &[String]) {
    for name in BIOS {
        let own = own_dir().join(name);
        let theirs = found.iter().find(|p| p.rsplit('/').next().map_or(false, |n| n.eq_ignore_ascii_case(name)));
        match theirs.map(|p| read(p)) {
            Some(Ok(data)) => {
                if fs::read(&own).ok().as_deref() != Some(&data[..]) {
                    match fs::write(&own, &data) {
                        Ok(()) => info!("BIOS {} from {}", name, theirs.unwrap()),
                        Err(e) => warn!("BIOS {}: {}", name, e),
                    }
                }
            }
            Some(Err(e)) => warn!("BIOS {}: {}", name, e),
            None => {
                let _ = fs::remove_file(&own);
            }
        }
    }
}

struct Queue {
    files: VecDeque<(String, Vec<u8>)>,
    busy: bool,
}

fn queue() -> &'static (Mutex<Queue>, Condvar) {
    static QUEUE: OnceLock<(Mutex<Queue>, Condvar)> = OnceLock::new();
    QUEUE.get_or_init(|| {
        let _ = thread::Builder::new().name("retro-saves".into()).spawn(writer);
        (Mutex::new(Queue { files: VecDeque::new(), busy: false }), Condvar::new())
    })
}

fn writer() {
    let (lock, ready) = queue();
    loop {
        let (path, data) = {
            let mut q = lock.lock().unwrap();
            q.busy = false;
            ready.notify_all();
            while q.files.is_empty() {
                q = ready.wait(q).unwrap();
            }
            q.busy = true;
            q.files.pop_front().unwrap()
        };
        let mut tries = 0;
        loop {
            match retro_write(&path, &data) {
                Ok(()) => break,
                Err(e) if tries + 1 < RETRIES => {
                    tries += 1;
                    warn!("{} not written, again: {}", path, e);
                    thread::sleep(Duration::from_millis(500));
                }
                Err(e) => {
                    warn!("{} not written: {}", path, e);
                    break;
                }
            }
        }
    }
}

pub fn write_later(path: &str, data: Vec<u8>) {
    let (lock, ready) = queue();
    let mut q = lock.lock().unwrap();
    match q.files.iter_mut().find(|(p, _)| p == path) {
        Some(waiting) => waiting.1 = data,
        None => q.files.push_back((path.to_string(), data)),
    }
    ready.notify_all();
}

pub fn written(within: Duration) {
    let (lock, ready) = queue();
    let mut q = lock.lock().unwrap();
    let until = Instant::now() + within;
    while !q.files.is_empty() || q.busy {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        q = ready.wait_timeout(q, left).unwrap().0;
    }
}

pub fn write(path: &str, data: &[u8]) -> Result<(), String> {
    retro_write(path, data)
}

pub struct SaveFile {
    pub path: String,
    written: Vec<u8>,
    seen: Vec<u8>,
    changed: Option<Instant>,
    first: Option<Instant>,
}

impl SaveFile {
    pub fn new(path: String, data: &[u8]) -> SaveFile {
        SaveFile { path, written: data.to_vec(), seen: data.to_vec(), changed: None, first: None }
    }

    fn same(a: &[u8], b: &[u8]) -> bool {
        a == b || (a.len() != b.len() && (a.starts_with(b) || b.starts_with(a)))
    }

    pub fn check(&mut self, data: &[u8], now: Instant) {
        if data != &self.seen[..] {
            self.seen.clear();
            self.seen.extend_from_slice(data);
            if Self::same(data, &self.written) {
                self.written = self.seen.clone();
                self.changed = None;
                self.first = None;
                return;
            }
            self.changed = Some(now);
            self.first.get_or_insert(now);
        }
        if let (Some(changed), Some(first)) = (self.changed, self.first) {
            if now - changed >= QUIET || now - first >= AT_MOST {
                self.flush(data);
            }
        }
    }

    pub fn flush(&mut self, data: &[u8]) {
        self.changed = None;
        self.first = None;
        if Self::same(data, &self.written) {
            return;
        }
        self.written = data.to_vec();
        write_later(&self.path, self.written.clone());
    }
}
