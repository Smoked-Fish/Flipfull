use crate::log;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Component, Path, PathBuf};
use toolbox::games::{self, Row};

const MAX_DEPTH: usize = 6;
const MAX_FILES: usize = 20000;
const MEDIA_RW: u32 = 1023;

pub struct Storage {
    media: PathBuf,
    mounts: PathBuf,
}

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

impl Storage {
    pub fn phone() -> Storage {
        Storage { media: PathBuf::from("/data/media"), mounts: PathBuf::from("/proc/mounts") }
    }

    fn storages(&self) -> Vec<(PathBuf, bool)> {
        let mut found = vec![(self.media.clone(), false)];
        if let Ok(mounts) = fs::read_to_string(&self.mounts) {
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

    fn roots(&self) -> Vec<(PathBuf, bool)> {
        let mut roots: Vec<(PathBuf, bool)> = Vec::new();
        for (storage, sd) in self.storages() {
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

    fn checked(&self, path: &str, may: fn(&str) -> bool) -> Result<PathBuf, String> {
        let p = Path::new(path);
        if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
            return Err(format!("Not a path: {}", path));
        }
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name.starts_with('.') || !may(&name) {
            return Err(format!("Not a game's file: {}", name));
        }
        let parent = p.parent().and_then(|d| fs::canonicalize(d).ok()).ok_or_else(|| format!("No folder for {}", path))?;
        if !self.roots().iter().any(|(r, _)| parent.starts_with(r)) {
            return Err(format!("Not in a roms folder: {}", path));
        }
        Ok(parent.join(name))
    }

    pub fn listing(&self) -> String {
        let mut out = String::new();
        let mut count = 0;
        for (root, sd) in self.roots() {
            let _ = writeln!(out, "{}", Row::Root { path: root.display().to_string(), sd });
            walk(&root, 0, &mut out, &mut count);
        }
        out
    }

    pub fn open(&self, path: &str) -> Result<File, String> {
        let p = self.checked(path, games::readable)?;
        OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&p).map_err(|e| format!("{}: {}", path, e))
    }

    // written next to it then renamed
    pub fn write(&self, path: &str, data: &[u8]) -> Result<(), String> {
        let written = self.checked(path, games::written).and_then(|p| {
            let mut tmp = p.clone().into_os_string();
            tmp.push(".flipfull-tmp");
            let tmp = PathBuf::from(tmp);
            OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o664)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&tmp)
                .and_then(|mut f| {
                    if p.starts_with(&self.media) {
                        unsafe { libc::fchown(f.as_raw_fd(), 0, MEDIA_RW) };
                    }
                    f.write_all(data)?;
                    f.sync_all()
                })
                .and_then(|_| fs::rename(&tmp, &p))
                .map_err(|e| {
                    let _ = fs::remove_file(&tmp);
                    format!("{}: {}", path, e)
                })
        });
        if let Err(why) = &written {
            log(&format!("retro-write: {}", why));
        }
        written
    }
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
        } else if games::listed(&name) {
            let meta = fs::metadata(e.path()).unwrap_or(meta);
            if meta.is_file() {
                *count += 1;
                let row = Row::File { path: e.path().display().to_string(), size: meta.len(), mtime: meta.mtime() };
                let _ = writeln!(out, "{}", row);
            }
        }
    }
}

pub fn keypad() -> Result<File, String> {
    let device = fs::read_dir("/sys/class/input").ok().and_then(|dir| {
        dir.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).find(|name| {
            name.starts_with("event")
                && fs::read_to_string(format!("/sys/class/input/{}/device/name", name))
                .map_or(false, |n| n.trim().ends_with("matrix_keypad0"))
        })
    });
    let device = device.ok_or("No keypad")?;
    File::open(format!("/dev/input/{}", device)).map_err(|e| format!("keypad: {}", e))
}
