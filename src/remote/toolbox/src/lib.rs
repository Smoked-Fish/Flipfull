mod fd;
pub mod games;
mod role;
pub mod services;

pub use role::{Role, REGISTRY};

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::io::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;

const MAX_LINE: usize = 4096;
const MAX_WRITE: usize = 8 * 1024 * 1024;
const FILE_ANSWER: usize = 256;
const NONSENSE: &str = "toolboxd's answer made no sense";

struct Allowed {
    name: &'static str,
    file: &'static str,
    verbs: &'static [&'static str],
    chars: fn(u8) -> bool,
}

const SCRIPTS: [Allowed; 2] = [
    Allowed {
        name: "flipfull",
        file: "flipfull",
        verbs: &[
            "state", "features", "set", "removable", "google-client", "log", "restart", "reboot", "update",
            "uninstall",
        ],
        chars: |c| c.is_ascii_alphanumeric() || b"._-".contains(&c),
    },
    Allowed {
        name: "store",
        file: "store.sh",
        verbs: &["stage", "stage-file", "install", "install-pwa", "uninstall", "installed"],
        chars: |c| c.is_ascii_alphanumeric() || b"._~:/?#@!$&+,;=%-".contains(&c),
    },
];

#[derive(Debug)]
pub struct Script {
    allowed: &'static Allowed,
    words: Vec<String>,
}

impl Script {
    pub fn name(&self) -> &'static str {
        self.allowed.name
    }

    pub fn file(&self) -> &'static str {
        self.allowed.file
    }

    pub fn words(&self) -> &[String] {
        &self.words
    }
}

impl std::fmt::Debug for Allowed {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(self.name)
    }
}

#[derive(Debug)]
pub enum Request {
    Script(Script),
    Record(File),
    Keypad,
    ListGames,
    OpenGameFile(String),
    WriteGameFile { path: String, data: Vec<u8> },
}

#[derive(Debug)]
pub enum Answer {
    Text { ok: bool, text: String },
    File(File),
    HandedOver(UnixStream),
}

impl Request {
    pub fn script(name: &str, words: &[impl AsRef<str>]) -> Result<Request, String> {
        let allowed = SCRIPTS.iter().find(|s| s.name == name).ok_or_else(|| format!("Not a command: {}", name))?;
        let words: Vec<&str> = words.iter().map(|w| w.as_ref()).collect();
        // an empty word or one with a space would split into other words
        if let Some(bad) = words.iter().find(|w| w.is_empty() || !w.bytes().all(allowed.chars)) {
            return Err(format!("Not a command: {}", bad));
        }
        match words.first() {
            Some(verb) if allowed.verbs.contains(verb) => {}
            Some(verb) => return Err(format!("Not a command: {}", verb)),
            None => return Err("No command".into()),
        }
        let script = Request::Script(Script { allowed, words: words.iter().map(|w| w.to_string()).collect() });
        if script.line().len() > MAX_LINE {
            return Err("Too long".into());
        }
        Ok(script)
    }

    fn line(&self) -> String {
        match self {
            Request::Script(s) => format!("{} {}\n", s.name(), s.words.join(" ")),
            Request::Record(_) => "record\n".into(),
            Request::Keypad => "keypad\n".into(),
            Request::ListGames => "retro-list\n".into(),
            Request::OpenGameFile(path) => format!("retro-open {}\n", path),
            Request::WriteGameFile { path, data } => format!("retro-write {} {}\n", data.len(), path),
        }
    }

    pub fn send(&self, stream: &mut UnixStream) -> io::Result<()> {
        let line = self.line();
        if line.len() > MAX_LINE {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Too long"));
        }
        if line[..line.len() - 1].contains('\n') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Not a path"));
        }
        match self {
            Request::Record(file) => fd::send(stream, line.as_bytes(), file.as_raw_fd()),
            Request::WriteGameFile { data, .. } => stream.write_all(line.as_bytes()).and_then(|_| stream.write_all(data)),
            _ => stream.write_all(line.as_bytes()),
        }
    }

    pub fn read(stream: &mut UnixStream) -> Result<Request, String> {
        let mut line = Vec::new();
        let mut fd = None;
        let mut buf = [0u8; 512];
        while !line.contains(&b'\n') {
            if line.len() > MAX_LINE {
                return Err("Too long".into());
            }
            match fd::receive(stream, &mut buf) {
                Ok((n, got)) if n > 0 => {
                    line.extend_from_slice(&buf[..n]);
                    if fd.is_none() {
                        fd = got;
                    }
                }
                _ => return Err("No command".into()),
            }
        }
        let end = line.iter().position(|&b| b == b'\n').unwrap_or(line.len());
        let rest = line.split_off(end + 1);
        line.truncate(end);
        let line = String::from_utf8(line).map_err(|_| "Not a command")?;
        decode(&line, fd, rest, stream)
    }
}

fn decode(line: &str, fd: Option<OwnedFd>, rest: Vec<u8>, stream: &mut UnixStream) -> Result<Request, String> {
    let words: Vec<&str> = line.split(' ').filter(|w| !w.is_empty()).collect();
    if let Some(fd) = fd {
        return if words == ["record"] { Ok(Request::Record(File::from(fd))) } else { Err("Not a command".into()) };
    }
    let (verb, args) = line.split_once(' ').unwrap_or((line, ""));
    match verb {
        "keypad" if args.is_empty() => Ok(Request::Keypad),
        "retro-list" if args.is_empty() => Ok(Request::ListGames),
        "retro-open" if !args.is_empty() => Ok(Request::OpenGameFile(args.to_string())),
        "retro-write" => {
            let (size, path) =
                args.split_once(' ').and_then(|(n, p)| Some((n.parse::<usize>().ok()?, p))).ok_or("Not a command")?;
            if size > MAX_WRITE {
                return Err("Too big".into());
            }
            let mut data = rest;
            if data.len() < size {
                let start = data.len();
                data.resize(size, 0);
                stream.read_exact(&mut data[start..]).map_err(|e| format!("the data: {}", e))?;
            }
            data.truncate(size);
            Ok(Request::WriteGameFile { path: path.to_string(), data })
        }
        _ => match words.split_first() {
            Some((name, args)) => Request::script(name, args),
            None => Err("Not a command".into()),
        },
    }
}

impl Answer {
    pub fn ok(text: impl Into<String>) -> Answer {
        Answer::Text { ok: true, text: text.into() }
    }

    pub fn error(why: impl std::fmt::Display) -> Answer {
        Answer::Text { ok: false, text: format!("{}\n", why) }
    }

    pub fn send(&self, stream: &mut UnixStream) -> io::Result<()> {
        match self {
            Answer::Text { ok, text } => {
                stream.write_all(if *ok { b"ok\n" } else { b"error\n" })?;
                stream.write_all(text.as_bytes())
            }
            Answer::File(file) => fd::send(stream, b"ok\n", file.as_raw_fd()),
            Answer::HandedOver(_) => Ok(()),
        }
    }

    pub fn text(self) -> Result<String, String> {
        match self {
            Answer::Text { ok: true, text } => Ok(text),
            Answer::Text { ok: false, text } => Err(text.trim().to_string()),
            _ => Err(NONSENSE.into()),
        }
    }

    pub fn file(self) -> Result<File, String> {
        match self {
            Answer::File(file) => Ok(file),
            Answer::Text { ok: false, text } => Err(text.trim().to_string()),
            _ => Err("toolboxd sent no file".into()),
        }
    }

    pub fn handed_over(self) -> Result<UnixStream, String> {
        match self {
            Answer::HandedOver(stream) => Ok(stream),
            Answer::Text { ok: false, text } => Err(text.trim().to_string()),
            _ => Err(NONSENSE.into()),
        }
    }
}

fn parse(answer: &str) -> Result<Answer, String> {
    match answer.split_once('\n') {
        Some(("ok", text)) => Ok(Answer::Text { ok: true, text: text.to_string() }),
        Some(("error", text)) => Ok(Answer::Text { ok: false, text: text.to_string() }),
        _ => Err(NONSENSE.into()),
    }
}

fn receive_text(mut stream: UnixStream) -> Result<Answer, String> {
    let mut answer = String::new();
    stream.read_to_string(&mut answer).map_err(|e| e.to_string())?;
    parse(&answer)
}

fn receive_file(mut stream: UnixStream) -> Result<Answer, String> {
    let mut buf = [0u8; FILE_ANSWER];
    let (n, fd) = fd::receive(&stream, &mut buf).map_err(|e| e.to_string())?;
    if let Some(fd) = fd {
        return Ok(Answer::File(File::from(fd)));
    }
    let mut answer = String::from_utf8_lossy(&buf[..n]).into_owned();
    let _ = stream.read_to_string(&mut answer);
    parse(&answer)
}

pub fn ask(mut stream: UnixStream, request: &Request) -> Result<Answer, String> {
    request.send(&mut stream).map_err(|e| e.to_string())?;
    match request {
        Request::Record(_) => Ok(Answer::HandedOver(stream)),
        Request::Keypad | Request::OpenGameFile(_) => receive_file(stream),
        _ => receive_text(stream),
    }
}
