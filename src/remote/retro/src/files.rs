use flipfull_remote::{retro_list, retro_open, retro_write};
use log::warn;
use serde::Serialize;
use std::io::Read;
use std::os::unix::fs::MetadataExt;

const GAMES: &[(&str, &str)] = &[("gba", "GBA"), ("gbc", "GBC"), ("gb", "GB")];
pub const SLOTS: u32 = 4;

#[derive(Serialize, Clone)]
pub struct Game {
    pub path: String,
    pub title: String,
    pub system: &'static str,
    pub folder: String,
    pub sd: bool,
}

pub fn games() -> Result<Vec<Game>, String> {
    let listing = retro_list()?;
    let mut roots: Vec<(String, bool)> = Vec::new();
    let mut games = Vec::new();
    for line in listing.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        match f.as_slice() {
            ["root", path, kind] => roots.push((format!("{}/", path.trim_end_matches('/')), *kind == "sd")),
            ["file", path, _size, _mtime] => {
                let name = path.rsplit('/').next().unwrap_or(path);
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
    Ok(games)
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

pub fn write(path: &str, data: &[u8]) -> Result<(), String> {
    retro_write(path, data)
}

pub struct SaveFile {
    pub path: String,
    written: Vec<u8>,
}

impl SaveFile {
    pub fn new(path: String, data: &[u8]) -> SaveFile {
        SaveFile { path, written: data.to_vec() }
    }

    pub fn flush(&mut self, data: &[u8]) {
        if data == &self.written[..] {
            return;
        }
        self.written = data.to_vec();
        if let Err(e) = write(&self.path, data) {
            warn!("{} not written: {}", self.path, e);
        }
    }
}
