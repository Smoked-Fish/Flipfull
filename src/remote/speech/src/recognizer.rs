use crate::engine::{self, Model};
use flipfull_remote::own_dir;
use log::info;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

pub const NO_MODEL: &str = "no speech model downloaded";
const THREADS: usize = 4;
const IDLE: Duration = Duration::from_secs(15);

struct ModelFile {
    file: &'static str,
    name: &'static str,
    english: bool,
    size: u64,
    sha256: &'static str,
    url: &'static str,
}

const MODELS: [ModelFile; 2] = [
    ModelFile {
        file: "parakeet-tdt_ctc-110m-Q4_K_M.gguf",
        name: "Parakeet TDT-CTC 110M",
        english: true,
        size: 89_989_600,
        sha256: "486414fd90185a8c8a4ced7c123cfb133ff4f7958426c6b8bd9049946b56b448",
        url: "https://huggingface.co/handy-computer/parakeet-tdt_ctc-110m-gguf/resolve/766f172fe70eb66785e3371664f53762e0fbafaa/parakeet-tdt_ctc-110m-Q4_K_M.gguf",
    },
    ModelFile {
        file: "ggml-base-q5_1.bin",
        name: "Whisper Base",
        english: false,
        size: 59_707_625,
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin",
    },
];

struct Loaded {
    index: usize,
    model: Model,
}

struct Recognizer {
    want: AtomicUsize,
    loaded: Mutex<Option<Loaded>>,
    warm: AtomicBool,
    sessions: AtomicUsize,
    unload_now: AtomicBool,
    last_use: Mutex<Instant>,
    latest_job: AtomicU32,
    downloading: Mutex<()>,
}

fn path(file: &str) -> PathBuf {
    own_dir().join("models").join(file)
}

fn part(m: &ModelFile) -> PathBuf {
    path(&format!("{}.part", m.file))
}

fn ready(i: usize) -> bool {
    path(MODELS[i].file).is_file()
}

fn find(file: &str) -> Result<usize, String> {
    MODELS.iter().position(|m| m.file == file.trim()).ok_or_else(|| format!("no model called {}", file))
}

fn sha256(p: &Path) -> io::Result<String> {
    let mut h = Sha256::new();
    io::copy(&mut File::open(p)?, &mut h)?;
    Ok(format!("{:x}", h.finalize()))
}

fn get() -> &'static Recognizer {
    static ONE: OnceLock<Recognizer> = OnceLock::new();
    ONE.get_or_init(|| {
        engine::init();
        let want = fs::read_to_string(own_dir().join("model")).ok().and_then(|f| find(&f).ok()).unwrap_or(0);
        thread::spawn(unload_when_idle);
        Recognizer {
            want: AtomicUsize::new(want),
            loaded: Mutex::new(None),
            warm: AtomicBool::new(false),
            sessions: AtomicUsize::new(0),
            unload_now: AtomicBool::new(false),
            last_use: Mutex::new(Instant::now()),
            latest_job: AtomicU32::new(0),
            downloading: Mutex::new(()),
        }
    })
}

impl Recognizer {
    fn current(&self) -> Option<usize> {
        let want = self.want.load(Ordering::SeqCst);
        if ready(want) {
            Some(want)
        } else {
            (0..MODELS.len()).find(|&i| ready(i))
        }
    }

    fn touch(&self) {
        *self.last_use.lock().unwrap() = Instant::now();
    }

    fn ensure(&self, loaded: &mut Option<Loaded>) -> Result<(), String> {
        self.touch();
        let want = self.current().ok_or_else(|| NO_MODEL.to_string())?;
        if loaded.as_ref().map(|l| l.index) == Some(want) {
            return Ok(());
        }
        if loaded.take().is_some() {
            self.warm.store(false, Ordering::SeqCst);
        }
        let m = &MODELS[want];
        let t0 = Instant::now();
        let model = Model::load(&path(m.file).to_string_lossy(), THREADS, m.english)
            .ok_or_else(|| format!("{} failed to load", m.file))?;
        info!("loaded {} in {} ms", m.file, t0.elapsed().as_millis());
        *loaded = Some(Loaded { index: want, model });
        Ok(())
    }

    fn run(
        &self,
        loaded: &mut Option<Loaded>,
        audio: &[u8],
        lang: Option<&str>,
        job: Option<u32>,
        gone: &dyn Fn() -> bool,
    ) -> Result<(String, f32, i64), String> {
        self.ensure(loaded)?;
        let superseded = || job.map_or(false, |j| j != self.latest_job.load(Ordering::SeqCst));
        let stop = || superseded() || gone();
        let result = loaded.as_mut().unwrap().model.transcribe(audio, lang, &stop);
        self.touch();
        if result.is_ok() {
            self.warm.store(true, Ordering::SeqCst);
        }
        result.map_err(|e| if superseded() { "superseded by a newer request".into() } else { e })
    }

    fn warm_up(&'static self) {
        thread::spawn(move || {
            let mut loaded = self.loaded.lock().unwrap();
            if self.sessions.load(Ordering::SeqCst) == 0
                || (self.warm.load(Ordering::SeqCst) && loaded.as_ref().map(|l| l.index) == self.current())
            {
                return;
            }
            let t0 = Instant::now();
            match self.run(&mut loaded, &[0u8; 32000], None, None, &|| false) {
                Ok(_) => info!("ready in {} ms", t0.elapsed().as_millis()),
                Err(e) => info!("warm-up failed: {}", e),
            }
        });
    }

    fn models_json(&self) -> Value {
        let list: Vec<Value> = MODELS
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let bytes = if ready(i) { m.size } else { fs::metadata(part(m)).map(|p| p.len()).unwrap_or(0) };
                json!({
                    "file": m.file,
                    "name": m.name,
                    "english": m.english,
                    "mb": (m.size + 500_000) / 1_000_000,
                    "size": m.size,
                    "bytes": bytes,
                    "ready": ready(i),
                    "url": m.url,
                })
            })
            .collect();
        json!({"current": self.current().map(|i| MODELS[i].file), "models": list})
    }
}

fn unload_when_idle() {
    let r = get();
    loop {
        thread::sleep(Duration::from_secs(1));
        if r.sessions.load(Ordering::SeqCst) > 0 {
            continue;
        }
        let now = r.unload_now.load(Ordering::SeqCst);
        if !now && r.last_use.lock().unwrap().elapsed() < IDLE {
            continue;
        }
        if let Ok(mut loaded) = r.loaded.try_lock() {
            if let Some(old) = loaded.take() {
                info!("unloaded {} ({})", MODELS[old.index].file, if now { "no session open" } else { "idle" });
                r.warm.store(false, Ordering::SeqCst);
            }
            r.unload_now.store(false, Ordering::SeqCst);
        }
    }
}

pub fn open_session() -> Result<(), String> {
    let r = get();
    r.current().ok_or_else(|| NO_MODEL.to_string())?;
    r.sessions.fetch_add(1, Ordering::SeqCst);
    r.unload_now.store(false, Ordering::SeqCst);
    r.warm_up();
    Ok(())
}

pub fn close_session() {
    let r = get();
    if r.sessions.fetch_sub(1, Ordering::SeqCst) == 1 {
        r.unload_now.store(true, Ordering::SeqCst);
    }
}

pub fn health() -> Value {
    let r = get();
    let m = r.current().map(|i| &MODELS[i]);
    json!({
        "ok": true,
        "loaded": r.loaded.try_lock().map(|l| l.is_some()).unwrap_or(true),
        "model": m.map(|m| m.file),
        "name": m.map(|m| m.name),
        "threads": THREADS,
        "sessions": r.sessions.load(Ordering::SeqCst),
    })
}

pub fn models() -> Value {
    get().models_json()
}

pub fn use_model(file: &str) -> Result<Value, String> {
    let r = get();
    let i = find(file)?;
    if !ready(i) {
        return Err(format!("{} isn't downloaded", MODELS[i].name));
    }
    if r.want.swap(i, Ordering::SeqCst) != i {
        if let Err(e) = fs::write(own_dir().join("model"), format!("{}\n", MODELS[i].file)) {
            info!("can't save the model choice: {}", e);
        }
        if r.sessions.load(Ordering::SeqCst) > 0 {
            r.warm_up();
        } else {
            r.unload_now.store(true, Ordering::SeqCst);
        }
    }
    Ok(r.models_json())
}

pub fn download(file: &str, offset: u64, piece: &[u8]) -> Result<Value, String> {
    let r = get();
    let m = &MODELS[find(file)?];
    let _one = r.downloading.lock().unwrap();
    if path(m.file).is_file() {
        return Ok(r.models_json());
    }
    let have = fs::metadata(part(m)).map(|p| p.len()).unwrap_or(0);
    if offset != 0 && offset != have {
        return Err(format!("{} has {} bytes, not {}", m.file, have, offset));
    }
    let end = offset + piece.len() as u64;
    if end > m.size {
        let _ = fs::remove_file(part(m));
        return Err(format!("{} is bigger than it should be", m.name));
    }
    fs::create_dir_all(path("")).map_err(|e| e.to_string())?;
    let opened = if offset == 0 { File::create(part(m)) } else { OpenOptions::new().append(true).open(part(m)) };
    opened.and_then(|mut f| f.write_all(piece)).map_err(|e| e.to_string())?;
    if end == m.size {
        if sha256(&part(m)).map_err(|e| e.to_string())? != m.sha256 {
            let _ = fs::remove_file(part(m));
            return Err(format!("{} doesn't match its checksum, download it again", m.name));
        }
        fs::rename(part(m), path(m.file)).map_err(|e| e.to_string())?;
        info!("downloaded {}", m.file);
    }
    Ok(r.models_json())
}

pub fn delete_model(file: &str) -> Result<Value, String> {
    let r = get();
    let i = find(file)?;
    let _one = r.downloading.lock().unwrap();
    let mut loaded = r.loaded.lock().unwrap();
    if loaded.as_ref().map(|l| l.index) == Some(i) {
        *loaded = None;
        r.warm.store(false, Ordering::SeqCst);
    }
    let _ = fs::remove_file(part(&MODELS[i]));
    let _ = fs::remove_file(path(MODELS[i].file));
    info!("deleted {}", MODELS[i].file);
    drop(loaded);
    Ok(r.models_json())
}

pub fn transcribe(audio: &[u8], lang: Option<&str>, gone: &dyn Fn() -> bool) -> Result<(String, f32, i64, u128), String> {
    let r = get();
    let job = r.latest_job.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let mut loaded = r.loaded.lock().unwrap();
    if job != r.latest_job.load(Ordering::SeqCst) {
        return Err("superseded by a newer request".into());
    }
    let t0 = Instant::now();
    let (text, confidence, audio_ms) = r.run(&mut loaded, audio, lang, Some(job), gone).map_err(|e| {
        info!("abandoned the audio after {} ms: {}", t0.elapsed().as_millis(), e);
        e
    })?;
    let ms = t0.elapsed().as_millis();
    info!("transcribed {} ms of audio in {} ms ({} chars)", audio_ms, ms, text.len());
    Ok((text, confidence, audio_ms, ms))
}
