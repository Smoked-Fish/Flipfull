fn main() {
    common::build_helper::build_service("retro");

    println!("cargo:rerun-if-env-changed=RETRO_CORE");
    let core = std::env::var("RETRO_CORE").expect("RETRO_CORE: run src/remote/build.sh");
    println!("cargo:rustc-link-search=native={}", core);
    println!("cargo:rustc-link-lib=static=mgba_retro");
}
