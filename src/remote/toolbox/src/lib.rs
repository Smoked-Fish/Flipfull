mod fd;
pub mod games;
pub mod services_ini;

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::io::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;

pub const USERINIT: &str = "/data/local/userinit";
pub const REGISTRY: &str = "/data/local/service/api-daemon/remote_services.toml";
const FIRST_UID: u32 = 10000;
const MAX_LINE: usize = 4096;
const MAX_WRITE: usize = 8 * 1024 * 1024;
const FILE_ANSWER: usize = 256;
const NONSENSE: &str = "toolboxd's answer made no sense";

// a request's verb starts its line, and services.ini's toolbox = lists the verbs each remote service may use
const RECORD: &str = "record";
const KEYPAD: &str = "keypad";
const LIST_GAMES: &str = "retro-list";
const OPEN_GAME_FILE: &str = "retro-open";
const WRITE_GAME_FILE: &str = "retro-write";

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

pub enum Request {
    Script(Script),
    Record(File),
    Keypad,
    ListGames,
    OpenGameFile(String),
    WriteGameFile { path: String, data: Vec<u8> },
}

// how toolboxd answers a request; an error is text whatever the request
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Reply {
    Text,
    File,
    // "ok", then the socket is the recorder's
    Stream,
}

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

    pub fn verb(&self) -> &'static str {
        match self {
            Request::Script(s) => s.name(),
            Request::Record(_) => RECORD,
            Request::Keypad => KEYPAD,
            Request::ListGames => LIST_GAMES,
            Request::OpenGameFile(_) => OPEN_GAME_FILE,
            Request::WriteGameFile { .. } => WRITE_GAME_FILE,
        }
    }

    pub fn reply(&self) -> Reply {
        match self {
            Request::Record(_) => Reply::Stream,
            Request::Keypad | Request::OpenGameFile(_) => Reply::File,
            Request::Script(_) | Request::ListGames | Request::WriteGameFile { .. } => Reply::Text,
        }
    }

    fn line(&self) -> String {
        match self {
            Request::Script(s) => format!("{} {}\n", s.name(), s.words.join(" ")),
            Request::OpenGameFile(path) => format!("{} {}\n", OPEN_GAME_FILE, path),
            Request::WriteGameFile { path, data } => format!("{} {} {}\n", WRITE_GAME_FILE, data.len(), path),
            _ => format!("{}\n", self.verb()),
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

// the verbs services.ini's toolbox = gives the remote service api-daemon runs as a uid
pub struct Grant(&'static str);

impl Grant {
    pub fn of_uid(uid: u32, registry: &str) -> Option<Grant> {
        let (service, _) = registry.lines().filter_map(registry_entry).find(|&(_, n)| FIRST_UID + u32::from(n) == uid)?;
        services_ini::value(service, "toolbox").map(Grant)
    }

    pub fn allows(&self, request: &Request) -> bool {
        self.0.split_whitespace().any(|verb| verb == request.verb())
    }
}

fn registry_entry(line: &str) -> Option<(&str, u16)> {
    let (name, n) = line.split_once('=')?;
    let n = n.trim();
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((name.trim(), n.parse().ok()?))
}

fn decode(line: &str, fd: Option<OwnedFd>, rest: Vec<u8>, stream: &mut UnixStream) -> Result<Request, String> {
    if let Some(fd) = fd {
        return if line == RECORD { Ok(Request::Record(File::from(fd))) } else { Err("Not a command".into()) };
    }
    let (verb, args) = line.split_once(' ').unwrap_or((line, ""));
    match verb {
        KEYPAD if args.is_empty() => Ok(Request::Keypad),
        LIST_GAMES if args.is_empty() => Ok(Request::ListGames),
        OPEN_GAME_FILE if !args.is_empty() => Ok(Request::OpenGameFile(args.to_string())),
        WRITE_GAME_FILE => {
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
        _ => {
            let words: Vec<&str> = line.split(' ').filter(|w| !w.is_empty()).collect();
            match words.split_first() {
                Some((name, args)) => Request::script(name, args),
                None => Err("Not a command".into()),
            }
        }
    }
}

impl Answer {
    pub fn ok(text: impl Into<String>) -> Answer {
        Answer::Text { ok: true, text: text.into() }
    }

    pub fn error(why: impl std::fmt::Display) -> Answer {
        Answer::Text { ok: false, text: format!("{}\n", why) }
    }

    // toolboxd's side: an answer that isn't what the request expects goes back as an error
    pub fn send(&self, reply: Reply, stream: &mut UnixStream) -> io::Result<()> {
        match (self, reply) {
            (Answer::Text { ok: false, text }, _) => {
                stream.write_all(b"error\n")?;
                stream.write_all(text.as_bytes())
            }
            (Answer::Text { ok: true, text }, Reply::Text) => {
                stream.write_all(b"ok\n")?;
                stream.write_all(text.as_bytes())
            }
            (Answer::File(file), Reply::File) => fd::send(stream, b"ok\n", file.as_raw_fd()),
            (Answer::Text { ok: true, .. }, Reply::Stream) => stream.write_all(b"ok\n"),
            _ => Answer::error("toolboxd answered the wrong way").send(reply, stream),
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

// one byte at a time: what follows "ok" is the recorder's
fn receive_stream(mut stream: UnixStream) -> Result<Answer, String> {
    let mut line = Vec::new();
    let mut byte = [0u8];
    while line.last() != Some(&b'\n') {
        if line.len() > MAX_LINE || stream.read(&mut byte).map_err(|e| e.to_string())? == 0 {
            return Err(NONSENSE.into());
        }
        line.push(byte[0]);
    }
    if line == b"ok\n" {
        return Ok(Answer::HandedOver(stream));
    }
    let mut answer = String::from_utf8_lossy(&line).into_owned();
    let _ = stream.read_to_string(&mut answer);
    parse(&answer)
}

pub fn ask(mut stream: UnixStream, request: &Request) -> Result<Answer, String> {
    request.send(&mut stream).map_err(|e| e.to_string())?;
    match request.reply() {
        Reply::Text => receive_text(stream),
        Reply::File => receive_file(stream),
        Reply::Stream => receive_stream(stream),
    }
}
