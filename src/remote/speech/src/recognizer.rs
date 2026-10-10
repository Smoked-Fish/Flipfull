use crate::engine::{self, Model};
use flipfull_remote::{own_dir, USERINIT};
use log::info;
use serde_json::{json, Value};
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_MODEL: &str = "parakeet-tdt_ctc-110m-Q4_K_M.gguf";
const THREADS: usize = 4;
const IDLE: Duration = Duration::from_secs(15);

struct ModelFile {
    file: String,
    name: String,
    english: bool,
    mb: u64,
}

struct Loaded {
    index: usize,
    model: Model,
}

struct Recognizer {
    models: Vec<ModelFile>,
    want: AtomicUsize,
    loaded: Mutex<Option<Loaded>>,
    warm: AtomicBool,
    sessions: AtomicUsize,
    unload_now: AtomicBool,
    last_use: Mutex<Instant>,
    latest_job: AtomicU32,
}

fn models_dir() -> String {
    format!("{}/remote/FlipfullSpeech/models", USERINIT)
}

fn scan() -> Vec<ModelFile> {
    let mut files: Vec<String> = fs::read_dir(models_dir())
        .map(|dir| {
            dir.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|f| f.ends_with(".gguf") || f.ends_with(".bin"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
        .into_iter()
        .filter_map(|file| {
            let path = format!("{}/{}", models_dir(), file);
            let (name, english) = engine::info(&path)?;
            let mb = fs::metadata(&path).map(|m| (m.len() + 500_000) / 1_000_000).unwrap_or(0);
            Some(ModelFile { file, name, english, mb })
        })
        .collect()
}

fn get() -> Result<&'static Recognizer, String> {
    static ONE: OnceLock<Option<Recognizer>> = OnceLock::new();
    ONE.get_or_init(|| {
        engine::init();
        let models = scan();
        if models.is_empty() {
            return None;
        }
        let find = |file: &str| models.iter().position(|m| m.file == file);
        let picked = fs::read_to_string(own_dir().join("model")).ok().and_then(|f| find(f.trim()));
        let want = picked.or_else(|| find(DEFAULT_MODEL)).unwrap_or(0);
        thread::spawn(unload_when_idle);
        Some(Recognizer {
            models,
            want: AtomicUsize::new(want),
            loaded: Mutex::new(None),
            warm: AtomicBool::new(false),
            sessions: AtomicUsize::new(0),
            unload_now: AtomicBool::new(false),
            last_use: Mutex::new(Instant::now()),
            latest_job: AtomicU32::new(0),
        })
    })
    .as_ref()
    .ok_or_else(|| format!("no speech models in {}", models_dir()))
}

impl Recognizer {
    fn touch(&self) {
        *self.last_use.lock().unwrap() = Instant::now();
    }

    fn ensure(&self, loaded: &mut Option<Loaded>) -> Result<(), String> {
        self.touch();
        let want = self.want.load(Ordering::SeqCst);
        if loaded.as_ref().map(|l| l.index) == Some(want) {
            return Ok(());
        }
        if loaded.take().is_some() {
            self.warm.store(false, Ordering::SeqCst);
        }
        let file = &self.models[want].file;
        let t0 = Instant::now();
        let model = Model::load(&format!("{}/{}", models_dir(), file), THREADS)
            .ok_or_else(|| format!("{} failed to load", file))?;
        info!("loaded {} in {} ms", file, t0.elapsed().as_millis());
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
            let want = self.want.load(Ordering::SeqCst);
            if self.sessions.load(Ordering::SeqCst) == 0
                || (self.warm.load(Ordering::SeqCst) && loaded.as_ref().map(|l| l.index) == Some(want))
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
        let list: Vec<Value> = self
            .models
            .iter()
            .map(|m| json!({"file": m.file, "name": m.name, "english": m.english, "mb": m.mb}))
            .collect();
        json!({"current": self.models[self.want.load(Ordering::SeqCst)].file, "models": list})
    }
}

fn unload_when_idle() {
    let r = get().unwrap();
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
                info!("unloaded {} ({})", r.models[old.index].file, if now { "no session open" } else { "idle" });
                r.warm.store(false, Ordering::SeqCst);
            }
            r.unload_now.store(false, Ordering::SeqCst);
        }
    }
}

pub fn open_session() -> Result<(), String> {
    let r = get()?;
    r.sessions.fetch_add(1, Ordering::SeqCst);
    r.unload_now.store(false, Ordering::SeqCst);
    r.warm_up();
    Ok(())
}

pub fn close_session() {
    if let Ok(r) = get() {
        if r.sessions.fetch_sub(1, Ordering::SeqCst) == 1 {
            r.unload_now.store(true, Ordering::SeqCst);
        }
    }
}

pub fn health() -> Result<Value, String> {
    let r = get()?;
    let want = &r.models[r.want.load(Ordering::SeqCst)];
    Ok(json!({
        "ok": true,
        "loaded": r.loaded.try_lock().map(|l| l.is_some()).unwrap_or(true),
        "model": want.file,
        "name": want.name,
        "threads": THREADS,
        "sessions": r.sessions.load(Ordering::SeqCst),
    }))
}

pub fn models() -> Result<Value, String> {
    Ok(get()?.models_json())
}

pub fn use_model(file: &str) -> Result<Value, String> {
    let r = get()?;
    let file = file.trim();
    let i = r.models.iter().position(|m| m.file == file).ok_or_else(|| format!("no model called {}", file))?;
    if r.want.swap(i, Ordering::SeqCst) != i {
        if let Err(e) = fs::write(own_dir().join("model"), format!("{}\n", file)) {
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

pub fn transcribe(audio: &[u8], lang: Option<&str>, gone: &dyn Fn() -> bool) -> Result<(String, f32, i64, u128), String> {
    let r = get()?;
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
