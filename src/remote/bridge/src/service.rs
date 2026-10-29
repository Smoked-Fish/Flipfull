use crate::generated::common::*;
use crate::generated::service::*;
use log::error;
use std::thread;
use std::time::Duration;
use toolbox::Request;

const TIMEOUT: Duration = Duration::from_secs(600);

pub struct Bridge {
    script: &'static str,
}

fn run(script: &'static str, words: &[String]) -> Result<String, Failure> {
    let request = Request::script(script, words)?;
    let answer = flipfull_remote::ask(&request, Some(TIMEOUT)).map_err(|f| {
        error!("{} {}: {}", script, words.first().map_or("", String::as_str), f);
        f
    })?;
    Ok(answer.text()?)
}

impl BridgeMethods for Bridge {
    fn run(&mut self, responder: BridgeRunResponder, words: Vec<String>) {
        let script = self.script;
        thread::spawn(move || flipfull_remote::settle!(responder, run(script, &words)));
    }
}

flipfull_remote::remote_service!(Bridge: FlipfullBridge, |origin| Bridge {
    script: if origin == "http://ostore.localhost" { "store" } else { "flipfull" },
});
