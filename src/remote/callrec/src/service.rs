use crate::generated::common::*;
use crate::generated::service::*;
use common::core::BaseMessage;
use common::traits::{
    EmptyConfig, EmptyState, OriginAttributes, Service, SessionSupport, Shared, SharedServiceState,
    SharedSessionContext,
};
use flipfull_remote::{feature_on, own_dir};
use log::info;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::Duration;
use toolbox::Request;

const START_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const PIECE: u64 = 512 * 1024;
const PART: &str = "rec.part";

struct Recorder {
    stream: UnixStream,
    lines: BufReader<UnixStream>,
    r#type: String,
    ext: String,
}

#[derive(Default)]
struct State {
    recorder: Option<Recorder>,
    last: Option<Recording>,
}

pub struct Callrec;

fn state() -> MutexGuard<'static, State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Mutex::default).lock().unwrap()
}

fn failure(message: impl Into<String>) -> Failure {
    Failure { message: message.into(), offline: false }
}

fn path(name: &str) -> PathBuf {
    own_dir().join(name)
}

fn new_file() -> std::io::Result<File> {
    for name in &[PART, "rec.m4a", "rec.wav"] {
        let _ = fs::remove_file(path(name));
    }
    OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(path(PART))
}

fn next_line(lines: &mut BufReader<UnixStream>) -> Result<(String, String), Failure> {
    let mut line = String::new();
    match lines.read_line(&mut line) {
        Ok(0) => Err(failure("the recorder exited; see toolboxd.log")),
        Ok(_) => {
            let line = line.trim_end();
            let (word, rest) = line.split_once(' ').unwrap_or((line, ""));
            Ok((word.to_string(), rest.to_string()))
        }
        Err(e) => Err(failure(format!("the recorder didn't answer: {}", e))),
    }
}

fn start() -> Result<(), Failure> {
    let mut state = state();
    if state.recorder.take().is_some() {
        info!("start: a recording was still going; it ends");
    }
    state.last = None;
    let file = new_file().map_err(|e| failure(format!("can't make the recording's file: {}", e)))?;
    let stream = flipfull_remote::ask(&Request::Record(file), None)
        .and_then(|answer| answer.handed_over())
        .map_err(|why| Failure { message: why, offline: true })?;
    let read = stream.try_clone().map_err(|e| failure(e.to_string()))?;
    read.set_read_timeout(Some(START_TIMEOUT)).map_err(|e| failure(e.to_string()))?;
    let mut lines = BufReader::new(read);
    let (word, rest) = next_line(&mut lines)?;
    match word.as_str() {
        "recording" => {
            let (r#type, ext) = rest.split_once(' ').unwrap_or(("", ""));
            info!("recording as {}", r#type);
            state.recorder = Some(Recorder { stream, lines, r#type: r#type.into(), ext: ext.into() });
            Ok(())
        }
        "error" => Err(failure(rest)),
        _ => Err(failure(format!("the recorder said {}", word))),
    }
}

fn stop() -> Result<Recording, Failure> {
    let mut state = state();
    let mut rec = match state.recorder.take() {
        Some(rec) => rec,
        None => return state.last.clone().ok_or_else(|| failure("not recording")),
    };
    rec.stream.write_all(b"stop\n").map_err(|e| failure(format!("the recorder went away: {}", e)))?;
    let _ = rec.lines.get_ref().set_read_timeout(Some(STOP_TIMEOUT));
    let (word, rest) = next_line(&mut rec.lines)?;
    match word.as_str() {
        "done" => {}
        "error" => return Err(failure(rest)),
        _ => return Err(failure(format!("the recorder said {}", word))),
    }
    let mut numbers = rest.split(' ').map(|n| n.parse().unwrap_or(0));
    let seconds = numbers.next().unwrap_or(0);
    let peak = numbers.next().unwrap_or(0);
    let file = format!("rec.{}", rec.ext);
    fs::rename(path(PART), path(&file)).map_err(|e| failure(format!("the recording is gone: {}", e)))?;
    let size = fs::metadata(path(&file)).map(|m| m.len() as i64).unwrap_or(0);
    info!("recorded {} s as {} ({} bytes)", seconds, file, size);
    let done = Recording { file, r#type: rec.r#type, ext: rec.ext, seconds, peak, size };
    state.last = Some(done.clone());
    Ok(done)
}

fn read(offset: u64) -> Result<Vec<u8>, Failure> {
    let file = match &*state() {
        State { recorder: None, last: Some(last) } => last.file.clone(),
        _ => return Err(failure("no finished recording")),
    };
    let mut f = File::open(path(&file)).map_err(|_| failure("the recording is gone"))?;
    let mut piece = Vec::new();
    f.seek(SeekFrom::Start(offset))
        .and_then(|_| f.take(PIECE).read_to_end(&mut piece))
        .map_err(|e| failure(e.to_string()))?;
    Ok(piece)
}

impl CallrecMethods for Callrec {
    fn start(&mut self, responder: CallrecStartResponder) {
        thread::spawn(move || match start() {
            Ok(()) => responder.resolve(),
            Err(f) => responder.reject(f),
        });
    }

    fn stop(&mut self, responder: CallrecStopResponder) {
        thread::spawn(move || match stop() {
            Ok(rec) => responder.resolve(rec),
            Err(f) => responder.reject(f),
        });
    }

    fn read(&mut self, responder: CallrecReadResponder, offset: i64) {
        match read(offset.max(0) as u64) {
            Ok(piece) => responder.resolve(piece),
            Err(f) => responder.reject(f),
        }
    }
}

impl FlipfullCallrec for Callrec {}

common::impl_shared_state!(Callrec, EmptyState, EmptyConfig);

impl Service<Callrec> for Callrec {
    fn create(
        attrs: &OriginAttributes,
        _context: SharedSessionContext,
        _helper: SessionSupport,
    ) -> Result<Callrec, String> {
        let who = attrs.identity();
        if who != "http://callscreen.localhost" {
            info!("refused {}", who);
            return Err(format!("Only the call screen, not {}", who));
        }
        if !feature_on("call-recording") {
            return Err("Call recording is off in Flipfull".into());
        }
        Ok(Callrec)
    }

    fn format_request(&mut self, _transport: &SessionSupport, _message: &BaseMessage) -> String {
        "FlipfullCallrec request".into()
    }

    fn on_request(&mut self, transport: &SessionSupport, message: &BaseMessage) {
        self.dispatch_request(transport, message);
    }

    fn release_object(&mut self, _object_id: u32) -> bool {
        false
    }
}
