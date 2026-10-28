#!/usr/bin/env bash
# TRANSCRIBE: a transcribe.cpp runs the GGUF models, and its ggml is the one everything here links against.
# WHISPER: a whisper.cpp v1.9.4 checkout: runs Whisper's .bin models. src/whisper.cpp is compiled, against transcribe.cpp's ggml.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: build.sh OUT}"
ZIG="${ZIG:-zig}"
TR="${TRANSCRIBE:-$HOME/kaistt/transcribe.cpp}"
W="${WHISPER:-$HOME/kaistt/whisper.cpp}"
OBJ="${OBJ:-$HOME/kaistt/obj}"
CMAKE="${CMAKE:-cmake}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
spawn() {
  while (( $(jobs -rp | wc -l) >= JOBS )); do wait -n; done
  "$@" &
  pids+=($!)
}

CPU=(-target aarch64-linux-musl -mcpu=cortex_a55)
OPT=(-O3 -fno-sanitize=all -ffunction-sections -fdata-sections)

ZIG="$(command -v "$ZIG")"
mkdir -p "$OBJ/zig" "$OUT"
for tool in cc c++ ar ranlib; do
  case $tool in cc|c++) flags="${CPU[*]}" ;; *) flags="" ;; esac
  printf '#!/bin/sh\nexec "%s" %s %s "$@"\n' "$ZIG" "$tool" "$flags" > "$OBJ/zig/$tool"
  chmod +x "$OBJ/zig/$tool"
done

"$CMAKE" -S "$TR" -B "$OBJ/transcribe" -G Ninja \
  -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER="$OBJ/zig/cc" -DCMAKE_CXX_COMPILER="$OBJ/zig/c++" \
  -DCMAKE_ASM_COMPILER="$OBJ/zig/cc" -DCMAKE_AR="$OBJ/zig/ar" -DCMAKE_RANLIB="$OBJ/zig/ranlib" \
  -DGGML_NATIVE=OFF -DTRANSCRIBE_METAL=OFF -DTRANSCRIBE_USE_SYSTEM_BLAS=OFF \
  -DTRANSCRIBE_BUILD_TESTS=OFF -DTRANSCRIBE_BUILD_EXAMPLES=OFF >/dev/null
"$CMAKE" --build "$OBJ/transcribe" -j "$JOBS" --target transcribe ggml ggml-base ggml-cpu

pids=()
GGML_INC=(-I"$TR/ggml/include")
spawn "$ZIG" c++ -std=gnu++17 "${CPU[@]}" "${OPT[@]}" -DNDEBUG '-DWHISPER_VERSION="1.9.4"' \
  -I"$W/include" "${GGML_INC[@]}" -c "$W/src/whisper.cpp" -o "$OBJ/whisper.o"
spawn "$ZIG" c++ -std=gnu++17 "${CPU[@]}" "${OPT[@]}" -DNDEBUG -DTRANSCRIBE_STATIC \
  -I"$TR/include" -I"$W/include" "${GGML_INC[@]}" \
  -c "$HERE/engine.cpp" -o "$OBJ/engine.o"
for p in "${pids[@]}"; do wait "$p"; done

rm -f "$OUT/libsttengine.a"
"$ZIG" ar rcs "$OUT/libsttengine.a" "$OBJ/engine.o" "$OBJ/whisper.o"
cp "$OBJ/transcribe/src/libtranscribe.a" "$OBJ/transcribe/ggml/src/libggml.a" \
   "$OBJ/transcribe/ggml/src/libggml-cpu.a" "$OBJ/transcribe/ggml/src/libggml-base.a" "$OUT/"
ls -la "$OUT"
