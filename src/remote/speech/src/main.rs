use common::expose_remote_service;

expose_remote_service!(flipfull_speech::service::Speech, flipfull_speech, Speech);

fn main() {
    flipfull_remote::init_log();
    if flipfull_remote::feature_on("web-speech") {
        flipfull_speech::speaktome::start();
    }
    if let Err(e) = session::Session::start() {
        log::error!("{:?}", e);
    }
}
