use std::fmt;

pub const GAMES: &[(&str, &str)] = &[("gba", "GBA"), ("gbc", "GBC"), ("gb", "GB")];
pub const BIOS: &[&str] = &["gba_bios.bin", "gb_bios.bin", "gbc_bios.bin", "sgb_bios.bin"];
pub const SLOTS: u32 = 4;

pub fn state_extension(slot: u32) -> String {
    if slot == 0 {
        "state".into()
    } else {
        format!("state{}", slot)
    }
}

pub fn extension(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

pub fn listed(name: &str) -> bool {
    let ext = extension(name);
    GAMES.iter().any(|(e, _)| *e == ext) || BIOS.contains(&name.to_ascii_lowercase().as_str())
}

pub fn written(name: &str) -> bool {
    let ext = extension(name);
    ext == "sav" || (0..SLOTS).any(|slot| state_extension(slot) == ext)
}

pub fn readable(name: &str) -> bool {
    listed(name) || written(name)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Root { path: String, sd: bool },
    File { path: String, size: u64, mtime: i64 },
}

impl Row {
    pub fn parse(line: &str) -> Option<Row> {
        let f: Vec<&str> = line.split('\t').collect();
        match f.as_slice() {
            ["root", path, kind] => Some(Row::Root { path: path.to_string(), sd: *kind == "sd" }),
            ["file", path, size, mtime] => {
                Some(Row::File { path: path.to_string(), size: size.parse().ok()?, mtime: mtime.parse().ok()? })
            }
            _ => None,
        }
    }
}

impl fmt::Display for Row {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Row::Root { path, sd } => write!(f, "root\t{}\t{}", path, if *sd { "sd" } else { "internal" }),
            Row::File { path, size, mtime } => write!(f, "file\t{}\t{}\t{}", path, size, mtime),
        }
    }
}
