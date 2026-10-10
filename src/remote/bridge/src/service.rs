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

const TIMEOUT: Duration = Duration::from_secs(600);
const MAX_COMMAND: usize = 4096;

pub struct Bridge {
    script: &'static str,
}

fn failure(message: String, offline: bool) -> Failure {
    Failure { message, offline }
}

fn command(words: &[String]) -> Result<String, Failure> {
    if let Some(w) = words.iter().find(|w| w.is_empty() || w.bytes().any(|b| !(0x21..0x7f).contains(&b))) {
        return Err(failure(format!("Not a command: {}", w), false));
    }
    let line = words.join(" ");
    if line.len() > MAX_COMMAND {
        return Err(failure("Too long".into(), false));
    }
    Ok(line)
}

impl BridgeMethods for Bridge {
    fn run(&mut self, responder: BridgeRunResponder, words: Vec<String>) {
        let line = match command(&words) {
            Ok(line) => line,
            Err(f) => return responder.reject(f),
        };
        let script = self.script;
        thread::spawn(move || match flipfull_remote::run(&format!("{} {}", script, line), TIMEOUT) {
            Ok((true, output)) => responder.resolve(output),
            Ok((false, output)) => responder.reject(failure(output.trim_end().to_string(), false)),
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
            "http://flipstore.localhost" => "store",
            _ => {
                info!("refused {}", who);
                return Err(format!("Only the Flipfull and Flipstore apps, not {}", who));
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
