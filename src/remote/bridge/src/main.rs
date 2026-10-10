use common::expose_remote_service;

expose_remote_service!(flipfull_bridge::service::Bridge, flipfull_bridge, Bridge);

fn main() {
    flipfull_remote::init_log();
    if let Err(e) = session::Session::start() {
        log::error!("{:?}", e);
    }
}
