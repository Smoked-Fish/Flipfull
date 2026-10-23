mod fd;
mod role;
pub mod services;

pub use role::{Role, REGISTRY};

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::io::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;

const MAX_LINE: usize = 4096;
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
}

#[derive(Debug)]
pub enum Answer {
    Text { ok: bool, text: String },
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
        }
    }

    pub fn send(&self, stream: &mut UnixStream) -> io::Result<()> {
        let line = self.line();
        if line.len() > MAX_LINE {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Too long"));
        }
        match self {
            Request::Record(file) => fd::send(stream, line.as_bytes(), file.as_raw_fd()),
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
        line.truncate(end);
        let line = String::from_utf8(line).map_err(|_| "Not a command")?;
        decode(&line, fd)
    }
}

fn decode(line: &str, fd: Option<OwnedFd>) -> Result<Request, String> {
    let words: Vec<&str> = line.split(' ').filter(|w| !w.is_empty()).collect();
    if let Some(fd) = fd {
        return if words == ["record"] { Ok(Request::Record(File::from(fd))) } else { Err("Not a command".into()) };
    }
    match words.split_first() {
        Some((name, args)) => Request::script(name, args),
        None => Err("Not a command".into()),
    }
}

impl Answer {
    pub fn send(&self, stream: &mut UnixStream) -> io::Result<()> {
        match self {
            Answer::Text { ok, text } => {
                stream.write_all(if *ok { b"ok\n" } else { b"error\n" })?;
                stream.write_all(text.as_bytes())
            }
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

pub fn ask(mut stream: UnixStream, request: &Request) -> Result<Answer, String> {
    request.send(&mut stream).map_err(|e| e.to_string())?;
    match request {
        Request::Record(_) => Ok(Answer::HandedOver(stream)),
        _ => receive_text(stream),
    }
}
