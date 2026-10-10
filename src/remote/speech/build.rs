fn main() {
    common::build_helper::build_service("speech");

    println!("cargo:rerun-if-env-changed=SPEECH_ENGINE");
    let engine = std::env::var("SPEECH_ENGINE").expect("SPEECH_ENGINE: run src/remote/build.sh");
    println!("cargo:rustc-link-search=native={}", engine);
    for lib in &["sttengine", "transcribe", "ggml", "ggml-cpu", "ggml-base"] {
        println!("cargo:rustc-link-lib=static={}", lib);
    }
    println!("cargo:rustc-link-lib=c++");
}
