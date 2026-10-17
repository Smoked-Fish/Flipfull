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
use serde_json::json;
use std::sync::{Mutex, MutexGuard, OnceLock};

const APP: &str = "http://retro.localhost";

pub struct Retro;

pub fn frontend() -> MutexGuard<'static, Frontend> {
    static FRONTEND: OnceLock<Mutex<Frontend>> = OnceLock::new();
    FRONTEND.get_or_init(Mutex::default).lock().unwrap()
}

fn failure(message: impl Into<String>) -> Failure {
    Failure { message: message.into(), offline: false }
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

    fn load(&mut self, responder: RetroLoadResponder, rom: Vec<u8>, save: Vec<u8>) {
        stream::stop();
        match frontend().load(&rom, &save) {
            Ok(game) => {
                info!(
                    "loaded a game: {} bytes, {} of save, {}x{} at {:.4} fps, sound at {}",
                    rom.len(),
                    save.len(),
                    game.width,
                    game.height,
                    game.fps,
                    game.rate
                );
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
        match frontend().reset() {
            Ok(()) => responder.resolve(),
            Err(why) => responder.reject(failure(why)),
        }
    }

    fn save_state(&mut self, responder: RetroSaveStateResponder) {
        match frontend().save_state() {
            Ok(state) => responder.resolve(state),
            Err(why) => responder.reject(failure(why)),
        }
    }

    fn load_state(&mut self, responder: RetroLoadStateResponder, state: Vec<u8>) {
        match frontend().load_state(&state) {
            Ok(()) => responder.resolve(),
            Err(why) => responder.reject(failure(why)),
        }
    }

    fn save(&mut self, responder: RetroSaveResponder) {
        match frontend().save_data() {
            Ok(data) => responder.resolve(data),
            Err(why) => responder.reject(failure(why)),
        }
    }

    fn unload(&mut self, responder: RetroUnloadResponder) {
        stream::stop();
        frontend().unload();
        responder.resolve();
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
        let who = attrs.identity();
        if who != APP {
            info!("refused {}", who);
            return Err(format!("Only the GBA app, not {}", who));
        }
        if !feature_on("gba") {
            return Err("GBA games are off in Flipfull".into());
        }
        Ok(Retro)
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
