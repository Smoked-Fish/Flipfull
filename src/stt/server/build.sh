#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ZIG="${ZIG:-$HOME/kaistt/zig/zig}"
W="${WHISPER:-$HOME/kaistt/whisper.cpp}"
OP="${OPUS:-$HOME/kaistt/opus}"
OBJ="${OBJ:-$HOME/kaistt/obj}"
OUT="$HERE/../../../userinit/services/stt"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
spawn() {
  while (( $(jobs -rp | wc -l) >= JOBS )); do wait -n; done
  "$@" &
  pids+=($!)
}

ARCH=(-target aarch64-linux-musl -mcpu=cortex_a55)
DEFS=(-DNDEBUG -D_GNU_SOURCE -D_XOPEN_SOURCE=600
      -DGGML_USE_CPU -DGGML_USE_LLAMAFILE -DGGML_USE_CPU_REPACK
      -DGGML_USE_DOTPROD -DGGML_USE_FP16_VECTOR_ARITHMETIC
      -DGGML_SCHED_MAX_COPIES=4
      '-DGGML_VERSION="0.23.0"' '-DGGML_COMMIT="whisper.cpp-v1.9.4"'
      '-DWHISPER_VERSION="1.9.4"')
INC=(-I"$W/include" -I"$W/ggml/include" -I"$W/ggml/src" -I"$W/ggml/src/ggml-cpu" -I"$OBJ/gen"
     -I"$OP/include")
OPUS_DEFS=(-DOPUS_BUILD -DUSE_ALLOCA -DHAVE_LRINT -DHAVE_LRINTF -DNDEBUG)
OPUS_INC=(-I"$OP/include" -I"$OP/celt" -I"$OP/silk" -I"$OP/silk/float")
OPT=(-O3 -fno-sanitize=all -ffunction-sections -fdata-sections)

SRCS=(
  ggml/src/ggml.c ggml/src/ggml.cpp ggml/src/ggml-alloc.c ggml/src/ggml-backend.cpp
  ggml/src/ggml-backend-meta.cpp ggml/src/ggml-opt.cpp ggml/src/ggml-threading.cpp
  ggml/src/ggml-quants.c ggml/src/gguf.cpp ggml/src/ggml-backend-reg.cpp
  ggml/src/ggml-cpu/ggml-cpu.c ggml/src/ggml-cpu/ggml-cpu.cpp ggml/src/ggml-cpu/repack.cpp
  ggml/src/ggml-cpu/iqp.cpp ggml/src/ggml-cpu/hbm.cpp ggml/src/ggml-cpu/quants.c
  ggml/src/ggml-cpu/traits.cpp ggml/src/ggml-cpu/binary-ops.cpp ggml/src/ggml-cpu/unary-ops.cpp
  ggml/src/ggml-cpu/vec.cpp ggml/src/ggml-cpu/ops.cpp ggml/src/ggml-cpu/llamafile/sgemm.cpp
  ggml/src/ggml-cpu/arch/arm/quants.c ggml/src/ggml-cpu/arch/arm/repack.cpp
  src/whisper.cpp
)

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

mkdir -p "$OBJ/gen" "$OBJ/opus" "$OUT"
sed -e 's/@GGML_VERSION@/0.23.0/' -e 's/@GGML_BUILD_COMMIT@/whisper.cpp-v1.9.4/' \
  "$W/ggml/src/ggml-version.h.in" > "$OBJ/gen/ggml-version.h"
objs=()
pids=()
for s in "${SRCS[@]}"; do
  o="$OBJ/$(echo "$s" | tr / _).o"
  objs+=("$o")
  if [[ "$o" -nt "$W/$s" && "$o" -nt "$0" ]]; then continue; fi
  case "$s" in
    *.c)   cmd=("$ZIG" cc  -std=gnu11) ;;
    *.cpp) cmd=("$ZIG" c++ -std=gnu++17) ;;
  esac
  spawn "${cmd[@]}" "${ARCH[@]}" "${OPT[@]}" "${DEFS[@]}" "${INC[@]}" -c "$W/$s" -o "$o"
done
for s in "${OPUS_SRCS[@]}"; do
  o="$OBJ/opus/$(echo "$s" | tr / _).o"
  objs+=("$o")
  if [[ "$o" -nt "$OP/$s" && "$o" -nt "$0" ]]; then continue; fi
  spawn "$ZIG" cc -std=gnu11 "${ARCH[@]}" "${OPT[@]}" "${OPUS_DEFS[@]}" "${OPUS_INC[@]}" \
    -c "$OP/$s" -o "$o"
done
for p in "${pids[@]}"; do wait "$p"; done

"$ZIG" c++ -std=gnu++17 "${ARCH[@]}" "${OPT[@]}" "${DEFS[@]}" "${INC[@]}" \
  -c "$HERE/stt-server.cpp" -o "$OBJ/stt-server.o"
"$ZIG" c++ "${ARCH[@]}" -static -s -Wl,--gc-sections \
  "$OBJ/stt-server.o" "${objs[@]}" -o "$OUT/stt-server"

ls -la "$OUT/stt-server"
