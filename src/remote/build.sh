#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
UI="$ROOT/userinit"
CACHE="${CACHE:-$HOME/.cache/flipfull}"
API_DAEMON="${API_DAEMON:-$CACHE/api-daemon}"
API_DAEMON_COMMIT=a3e068fb58aaa785c10a6c72e25731ccb76ebd41
ARM32=armv7-unknown-linux-musleabihf
ARM64=aarch64-unknown-linux-musl
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CACHE/remote-target}"

# service, crate, client, target
SERVICES=(
    "FlipfullBridge flipfull_bridge bridge $ARM32"
    "FlipfullCallrec flipfull_callrec callrec $ARM32"
    "FlipfullSpeech flipfull_speech speech $ARM64"
)

for tool in cargo zig git python3; do
    command -v "$tool" >/dev/null || { echo "$tool not found" >&2; exit 1; }
done
cargo zigbuild --help >/dev/null 2>&1 || { echo "cargo-zigbuild not found (cargo install cargo-zigbuild)" >&2; exit 1; }

if [ "$(git -C "$API_DAEMON" rev-parse HEAD 2>/dev/null)" != "$API_DAEMON_COMMIT" ]; then
    echo "Fetching api-daemon $API_DAEMON_COMMIT into $API_DAEMON..."
    mkdir -p "$API_DAEMON"
    git -C "$API_DAEMON" init -q
    git -C "$API_DAEMON" fetch -q --depth 1 https://github.com/kaiostech/api-daemon.git "$API_DAEMON_COMMIT"
    git -C "$API_DAEMON" checkout -q --force FETCH_HEAD
fi
ln -sfn "$API_DAEMON" "$HERE/api-daemon"
[ -f "$HERE/Cargo.lock" ] || cp "$API_DAEMON/Cargo.lock" "$HERE/Cargo.lock"

# api-daemon's common crate links libselinux
STUB="$CACHE/stub"
mkdir -p "$STUB/host" "$STUB/$ARM32" "$STUB/$ARM64"
: > "$STUB/empty.c"
[ -f "$STUB/host/libselinux.a" ] ||
    { cc -c "$STUB/empty.c" -o "$STUB/host/empty.o" && ar rcs "$STUB/host/libselinux.a" "$STUB/host/empty.o"; }
for t in "$ARM32:arm-linux-musleabihf" "$ARM64:aarch64-linux-musl"; do
    dir="$STUB/${t%%:*}"
    [ -f "$dir/libselinux.a" ] ||
        { zig cc -target "${t#*:}" -c "$STUB/empty.c" -o "$dir/empty.o" && ar rcs "$dir/libselinux.a" "$dir/empty.o"; }
done

ENGINE="$CACHE/speech-engine"
echo "Building the speech recognizer..."
bash "$HERE/speech/engine/build.sh" "$ENGINE"

build() { # target packages...
    t=$1
    shift
    (cd "$HERE" && LIBRARY_PATH="$STUB/host" RUSTFLAGS="-L $STUB/$t --remap-path-prefix=$HOME=~" \
        SPEECH_ENGINE="$ENGINE" cargo zigbuild --offline --release --target "$t" "$@")
}

for t in $ARM32 $ARM64; do
    echo "Building for $t..."
    packages=()
    [ "$t" = $ARM32 ] && packages+=(-p toolboxd)
    for s in "${SERVICES[@]}"; do
        set -- $s
        [ "$4" = "$t" ] && packages+=(-p "$2")
    done
    build "$t" "${packages[@]}"
done

install -m 0755 "$CARGO_TARGET_DIR/$ARM32/release/toolboxd" "$UI/services/toolbox/toolboxd"
for s in "${SERVICES[@]}"; do
    set -- $s
    mkdir -p "$UI/remote/$1"
    install -m 0755 "$CARGO_TARGET_DIR/$4/release/flipfull-$3" "$UI/remote/$1/daemon"
done

echo "Bundling the JS clients..."
ESBUILD="$(cd "$ROOT/src" && python3 -c 'import minify; print(minify.esbuild())' | tail -n 1)"
for s in "${SERVICES[@]}"; do
    set -- $s
    gen="$HERE/$3/client/generated/$3_service.js"
    sed -i "s#'\.\./\.\./\.\./\.\./common/client/src/#'../../../api-daemon/common/client/src/#" "$gen"
    "$ESBUILD" "$HERE/client/$3.js" --bundle --minify --preserve-symlinks --format=iife --target=firefox123 \
        --charset=utf8 --legal-comments=none --log-level=warning \
        --banner:js="// Built by src/remote/build.sh from src/remote/client/$3.js. Do not edit." \
        --outfile="$UI/remote/$3.js"
done

ls -la "$UI/services/toolbox/toolboxd" "$UI"/remote/*/daemon "$UI"/remote/*.js
