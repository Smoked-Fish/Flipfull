use crate::generated::common::*;
use crate::generated::service::*;
use crate::recognizer;
use common::core::BaseMessage;
use common::traits::{
    EmptyConfig, EmptyState, OriginAttributes, Service, SessionSupport, Shared, SharedServiceState,
    SharedSessionContext,
};
use common::JsonValue;
use flipfull_remote::feature_on;
use log::info;
use serde_json::{json, Value};
use std::thread;

const KAIVA: &str = "http://kaios-voiceassistant.localhost";
const SYSTEM: &str = "http://system.localhost";
const MAX_CLIP: usize = 60 * 16000 * 2 + 1024;

pub struct Speech {
    session: bool,
    clip: Vec<u8>,
}

fn answer(result: Result<Value, String>) -> Result<JsonValue, Failure> {
    result.map(JsonValue::from).map_err(|message| Failure { offline: message == recognizer::NO_MODEL, message })
}

impl SpeechMethods for Speech {
    fn open(&mut self, responder: SpeechOpenResponder) {
        if !self.session {
            self.session = recognizer::open_session().is_ok();
        }
        responder.resolve(self.session)
    }

    fn close(&mut self, responder: SpeechCloseResponder) {
        if std::mem::take(&mut self.session) {
            recognizer::close_session();
        }
        responder.resolve();
    }

    fn health(&mut self, responder: SpeechHealthResponder) {
        responder.resolve(JsonValue::from(recognizer::health()));
    }

    fn models(&mut self, responder: SpeechModelsResponder) {
        responder.resolve(JsonValue::from(recognizer::models()));
    }

    fn use_model(&mut self, responder: SpeechUseModelResponder, file: String) {
        match answer(recognizer::use_model(&file)) {
            Ok(v) => responder.resolve(v),
            Err(f) => responder.reject(f),
        }
    }

    fn download(&mut self, responder: SpeechDownloadResponder, file: String, offset: i64, piece: Vec<u8>) {
        match answer(recognizer::download(&file, offset.max(0) as u64, &piece)) {
            Ok(v) => responder.resolve(v),
            Err(f) => responder.reject(f),
        }
    }

    fn delete_model(&mut self, responder: SpeechDeleteModelResponder, file: String) {
        match answer(recognizer::delete_model(&file)) {
            Ok(v) => responder.resolve(v),
            Err(f) => responder.reject(f),
        }
    }

    fn begin(&mut self, responder: SpeechBeginResponder) {
        self.clip.clear();
        responder.resolve();
    }

    fn append(&mut self, responder: SpeechAppendResponder, audio: Vec<u8>) {
        if self.clip.len() + audio.len() > MAX_CLIP {
            return responder.reject(Failure { message: "audio longer than 60 s".into(), offline: false });
        }
        self.clip.extend_from_slice(&audio);
        responder.resolve();
    }

    fn transcribe(&mut self, responder: SpeechTranscribeResponder) {
        let clip = std::mem::take(&mut self.clip);
        thread::spawn(move || {
            let result = recognizer::transcribe(&clip, None, &|| false)
                .map(|(text, _, audio_ms, ms)| json!({"text": text, "audio_ms": audio_ms, "ms": ms as u64}));
            match answer(result) {
                Ok(v) => responder.resolve(v),
                Err(f) => responder.reject(f),
            }
        });
    }
}

impl Drop for Speech {
    fn drop(&mut self) {
        if self.session {
            recognizer::close_session();
        }
    }
}

impl FlipfullSpeech for Speech {}

common::impl_shared_state!(Speech, EmptyState, EmptyConfig);

impl Service<Speech> for Speech {
    fn create(
        attrs: &OriginAttributes,
        _context: SharedSessionContext,
        _helper: SessionSupport,
    ) -> Result<Speech, String> {
        let who = attrs.identity();
        let feature = match who.as_str() {
            KAIVA => "kaiva",
            SYSTEM => "web-speech",
            _ => {
                info!("refused {}", who);
                return Err(format!("Only KaiVA, not {}", who));
            }
        };
        if !feature_on(feature) {
            return Err(format!("{} is off in Flipfull", feature));
        }
        Ok(Speech { session: false, clip: Vec::new() })
    }

    fn format_request(&mut self, _transport: &SessionSupport, _message: &BaseMessage) -> String {
        "FlipfullSpeech request".into()
    }

    fn on_request(&mut self, transport: &SessionSupport, message: &BaseMessage) {
        self.dispatch_request(transport, message);
    }

    fn release_object(&mut self, _object_id: u32) -> bool {
        false
    }
}
