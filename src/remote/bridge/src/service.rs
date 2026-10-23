use crate::generated::common::*;
use crate::generated::service::*;
use common::core::BaseMessage;
use common::traits::{
    EmptyConfig, EmptyState, OriginAttributes, Service, SessionSupport, Shared, SharedServiceState,
    SharedSessionContext,
};
use log::{error, info};
use std::thread;
use std::time::Duration;
use toolbox::{Answer, Request};

const TIMEOUT: Duration = Duration::from_secs(600);

pub struct Bridge {
    script: &'static str,
}

fn failure(message: String, offline: bool) -> Failure {
    Failure { message, offline }
}

impl BridgeMethods for Bridge {
    fn run(&mut self, responder: BridgeRunResponder, words: Vec<String>) {
        let request = match Request::script(self.script, &words) {
            Ok(request) => request,
            Err(why) => return responder.reject(failure(why, false)),
        };
        let script = self.script;
        thread::spawn(move || match flipfull_remote::ask(&request, Some(TIMEOUT)) {
            Ok(Answer::Text { ok: true, text }) => responder.resolve(text),
            Ok(Answer::Text { ok: false, text }) => responder.reject(failure(text.trim_end().to_string(), false)),
            Ok(_) => responder.reject(failure("toolboxd's answer made no sense".into(), true)),
            Err(why) => {
                error!("{} {}: {}", script, words.first().map_or("", String::as_str), why);
                responder.reject(failure(why, true))
            }
        });
    }
}

impl FlipfullBridge for Bridge {}

common::impl_shared_state!(Bridge, EmptyState, EmptyConfig);

impl Service<Bridge> for Bridge {
    fn create(
        attrs: &OriginAttributes,
        _context: SharedSessionContext,
        _helper: SessionSupport,
    ) -> Result<Bridge, String> {
        let who = attrs.identity();
        let script = match who.as_str() {
            "http://flipfull.localhost" => "flipfull",
            "http://ostore.localhost" => "store",
            _ => {
                info!("refused {}", who);
                return Err(format!("Only the Flipfull app and OStore, not {}", who));
            }
        };
        Ok(Bridge { script })
    }

    fn format_request(&mut self, _transport: &SessionSupport, _message: &BaseMessage) -> String {
        "FlipfullBridge request".into()
    }

    fn on_request(&mut self, transport: &SessionSupport, message: &BaseMessage) {
        self.dispatch_request(transport, message);
    }

    fn release_object(&mut self, _object_id: u32) -> bool {
        false
    }
}
