use crate::generated::common::*;
use crate::generated::service::*;
use common::traits::{EmptyConfig, EmptyState, Shared, SharedServiceState};
use log::error;
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

flipfull_remote::remote_service!(Bridge, |origin| Bridge {
    script: if origin == "http://ostore.localhost" { "store" } else { "flipfull" },
});
