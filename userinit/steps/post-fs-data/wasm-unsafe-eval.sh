edit_file "$API_DAEMON/config.toml" "/csp *= *\"/{ /wasm-unsafe-eval/!s/script-src /script-src 'wasm-unsafe-eval' /; };\
/csp *= *\"/{ /worker-src [^;]*blob:/!s/worker-src /worker-src blob: /; };\
/csp *= *\"/{ /script-src [^;]*blob:/!s/script-src /script-src blob: /; }"
