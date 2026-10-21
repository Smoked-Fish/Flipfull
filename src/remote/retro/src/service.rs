use crate::files::{self, SaveFile, SLOTS};
use crate::generated::common::*;
use crate::generated::service::*;
use crate::libretro::{self, Frontend};
use crate::stream;
use common::core::BaseMessage;
use common::traits::{
    EmptyConfig, EmptyState, OriginAttributes, Service, SessionSupport, Shared, SharedServiceState,
    SharedSessionContext,
};
use common::JsonValue;
use flipfull_remote::feature_on;
use log::info;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

const APP: &str = "http://retro.localhost";

pub struct Loaded {
    pub path: String,
    pub save: SaveFile,
}

#[derive(Default)]
pub struct State {
    pub frontend: Frontend,
    pub game: Option<Loaded>,
    owner: u32,
}

impl State {
    pub fn flush_save(&mut self) {
        let State { frontend, game, .. } = self;
        if let Some(g) = game.as_mut() {
            g.save.flush(frontend.save_data());
        }
    }

    fn unload(&mut self) {
        self.flush_save();
        self.frontend.unload();
        self.game = None;
    }
}

pub struct Retro {
    id: u32,
}

pub fn state() -> MutexGuard<'static, State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Mutex::default).lock().unwrap()
}

fn failure(message: impl Into<String>) -> Failure {
    Failure { message: message.into(), offline: false }
}

fn loaded_path() -> Result<String, Failure> {
    state().game.as_ref().map(|g| g.path.clone()).ok_or_else(|| failure("no game is loaded"))
}

fn slot(n: i64) -> Result<u32, Failure> {
    if n >= 0 && n < SLOTS as i64 {
        Ok(n as u32)
    } else {
        Err(failure(format!("no slot {}", n)))
    }
}

impl RetroMethods for Retro {
    fn info(&mut self, responder: RetroInfoResponder) {
        let (name, version, extensions) = libretro::info();
        responder.resolve(JsonValue::from(json!({
            "name": name,
            "version": version,
            "extensions": extensions.split('|').collect::<Vec<_>>(),
        })));
    }

    fn stream(&mut self, responder: RetroStreamResponder) {
        match stream::url() {
            Ok(url) => responder.resolve(url),
            Err(why) => responder.reject(failure(why)),
        }
    }

    fn games(&mut self, responder: RetroGamesResponder) {
        match files::games() {
            Ok(games) => responder.resolve(JsonValue::from(json!(games))),
            Err(why) => responder.reject(failure(why)),
        }
    }

    fn load(&mut self, responder: RetroLoadResponder, path: String) {
        stream::stop();
        let rom = match files::read(&path) {
            Ok(r) => r,
            Err(why) => return responder.reject(failure(why)),
        };
        let save_path = files::sibling(&path, "sav");
        let save = files::read(&save_path).unwrap_or_default();
        let mut s = state();
        s.unload();
        match s.frontend.load(&rom, &save) {
            Ok(game) => {
                info!(
                    "loaded {}: {} bytes, {} of save, {}x{} at {:.4} fps, sound at {}",
                    path,
                    rom.len(),
                    save.len(),
                    game.width,
                    game.height,
                    game.fps,
                    game.rate
                );
                let data = s.frontend.save_data().to_vec();
                s.game = Some(Loaded { path, save: SaveFile::new(save_path, &data) });
                s.owner = self.id;
                responder.resolve(Game {
                    width: game.width as i64,
                    height: game.height as i64,
                    frame_ns: (1e9 / game.fps).round() as i64,
                    rate: game.rate.round() as i64,
                })
            }
            Err(why) => responder.reject(failure(why)),
        }
    }

    fn reset(&mut self, responder: RetroResetResponder) {
        match state().frontend.reset() {
            Ok(()) => responder.resolve(),
            Err(why) => responder.reject(failure(why)),
        }
    }

    fn states(&mut self, responder: RetroStatesResponder) {
        match loaded_path() {
            Ok(path) => {
                let slots: Vec<Value> = (0..SLOTS)
                    .map(|n| json!({ "slot": n, "time": files::modified(&files::state_path(&path, n)).unwrap_or(0) }))
                    .collect();
                responder.resolve(JsonValue::from(json!(slots)))
            }
            Err(why) => responder.reject(why),
        }
    }

    fn save_state(&mut self, responder: RetroSaveStateResponder, n: i64) {
        let saved = slot(n).and_then(|n| {
            let (path, data) = {
                let mut s = state();
                s.flush_save();
                let path = s.game.as_ref().map(|g| g.path.clone()).ok_or_else(|| failure("no game is loaded"))?;
                (path, s.frontend.save_state().map_err(failure)?)
            };
            files::write(&files::state_path(&path, n), &data).map_err(failure)
        });
        match saved {
            Ok(()) => responder.resolve(),
            Err(why) => responder.reject(why),
        }
    }

    fn load_state(&mut self, responder: RetroLoadStateResponder, n: i64) {
        let loaded = slot(n).and_then(|n| {
            let data = files::read(&files::state_path(&loaded_path()?, n)).map_err(failure)?;
            state().frontend.load_state(&data).map_err(failure)
        });
        match loaded {
            Ok(()) => responder.resolve(),
            Err(why) => responder.reject(why),
        }
    }

    fn unload(&mut self, responder: RetroUnloadResponder) {
        stream::stop();
        state().unload();
        responder.resolve();
    }
}

impl Drop for Retro {
    fn drop(&mut self) {
        let mut s = state();
        if s.owner == self.id {
            stream::stop();
            s.unload();
        }
    }
}

impl FlipfullRetro for Retro {}

common::impl_shared_state!(Retro, EmptyState, EmptyConfig);

impl Service<Retro> for Retro {
    fn create(
        attrs: &OriginAttributes,
        _context: SharedSessionContext,
        _helper: SessionSupport,
    ) -> Result<Retro, String> {
        static NEXT: AtomicU32 = AtomicU32::new(1);
        let who = attrs.identity();
        if who != APP {
            info!("refused {}", who);
            return Err(format!("Only the GBA app, not {}", who));
        }
        if !feature_on("gba") {
            return Err("GBA games are off in Flipfull".into());
        }
        Ok(Retro { id: NEXT.fetch_add(1, Ordering::Relaxed) })
    }

    fn format_request(&mut self, _transport: &SessionSupport, _message: &BaseMessage) -> String {
        "FlipfullRetro request".into()
    }

    fn on_request(&mut self, transport: &SessionSupport, message: &BaseMessage) {
        self.dispatch_request(transport, message);
    }

    fn release_object(&mut self, _object_id: u32) -> bool {
        false
    }
}
