#!/usr/bin/env bash
#
# running 32-bit KaiOS userspace on a 64-bit kernel, so a static aarch64 binary runs fine from /data.
#
# TRANSCRIBE: a transcribe.cpp runs the GGUF models, and its ggml is the one everything here links against.
# WHISPER: a whisper.cpp v1.9.4 checkout: runs Whisper's .bin models. src/whisper.cpp is compiled, against transcribe.cpp's ggml.
# OPUS: a libopus 1.5.x checkout (decodes the Ogg/Opus the Web Speech API sends to /speaktome).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ZIG="${ZIG:-$HOME/kaistt/zig/zig}"
TR="${TRANSCRIBE:-$HOME/kaistt/transcribe.cpp}"
W="${WHISPER:-$HOME/kaistt/whisper.cpp}"
OP="${OPUS:-$HOME/kaistt/opus}"
OBJ="${OBJ:-$HOME/kaistt/obj}"
CMAKE="${CMAKE:-cmake}"
OUT="$HERE/../../../userinit/services/stt"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
spawn() {
  while (( $(jobs -rp | wc -l) >= JOBS )); do wait -n; done
  "$@" &
  pids+=($!)
}

CPU=(-target aarch64-linux-musl -mcpu=cortex_a55)
OPT=(-O3 -fno-sanitize=all -ffunction-sections -fdata-sections)
OPUS_DEFS=(-DOPUS_BUILD -DUSE_ALLOCA -DHAVE_LRINT -DHAVE_LRINTF -DNDEBUG)
OPUS_INC=(-I"$OP/include" -I"$OP/celt" -I"$OP/silk" -I"$OP/silk/float")

mkdir -p "$OBJ/zig" "$OBJ/opus" "$OUT"
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
LIBS=("$OBJ/transcribe/src/libtranscribe.a" "$OBJ/transcribe/ggml/src/libggml.a"
      "$OBJ/transcribe/ggml/src/libggml-cpu.a" "$OBJ/transcribe/ggml/src/libggml-base.a")

mk_sources() {
  awk -v var="$2" '$1 == var && $2 == "=" { on = 1; next }
                   on { for (i = 1; i <= NF; i++) if ($i ~ /\.c$/) print $i
                        if ($NF != "\\") on = 0 }' "$OP/$1"
}
OPUS_SRCS=($(mk_sources celt_sources.mk CELT_SOURCES)
           $(mk_sources silk_sources.mk SILK_SOURCES)
           $(mk_sources silk_sources.mk SILK_SOURCES_FLOAT)
           $(mk_sources opus_sources.mk OPUS_SOURCES)
           $(mk_sources opus_sources.mk OPUS_SOURCES_FLOAT))
[[ ${#OPUS_SRCS[@]} -gt 100 ]] || { echo "libopus sources not found in $OP" >&2; exit 1; }

objs=()
pids=()
for s in "${OPUS_SRCS[@]}"; do
  o="$OBJ/opus/$(echo "$s" | tr / _).o"
  objs+=("$o")
  if [[ "$o" -nt "$OP/$s" && "$o" -nt "$0" ]]; then continue; fi
  spawn "$ZIG" cc -std=gnu11 "${CPU[@]}" "${OPT[@]}" "${OPUS_DEFS[@]}" "${OPUS_INC[@]}" \
    -c "$OP/$s" -o "$o"
done
GGML_INC=(-I"$TR/ggml/include")
spawn "$ZIG" c++ -std=gnu++17 "${CPU[@]}" "${OPT[@]}" -DNDEBUG '-DWHISPER_VERSION="1.9.4"' \
  -I"$W/include" "${GGML_INC[@]}" -c "$W/src/whisper.cpp" -o "$OBJ/whisper.o"
for p in "${pids[@]}"; do wait "$p"; done

"$ZIG" c++ -std=gnu++17 "${CPU[@]}" "${OPT[@]}" -DNDEBUG -DTRANSCRIBE_STATIC \
  -I"$TR/include" -I"$W/include" "${GGML_INC[@]}" -I"$OP/include" \
  -c "$HERE/stt-server.cpp" -o "$OBJ/stt-server.o"
"$ZIG" c++ "${CPU[@]}" -static -s -Wl,--gc-sections \
  "$OBJ/stt-server.o" "$OBJ/whisper.o" "${objs[@]}" "${LIBS[@]}" -o "$OUT/stt-server"

ls -la "$OUT/stt-server"
