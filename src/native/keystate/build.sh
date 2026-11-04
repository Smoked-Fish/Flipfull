#!/usr/bin/env bash
set -euo pipefail

# needs the NDK that src/remote/callrec/callcap/setup.sh fetches
HERE="$(cd "$(dirname "$0")" && pwd)"
AB="${AB:-$HOME/ab}"
OUT="${OUT:-$HERE/../../../userinit/bin/keystate}"
CC="$AB/android-ndk-r27c/toolchains/llvm/prebuilt/linux-x86_64/bin/armv7a-linux-androideabi34-clang"

[ -x "$CC" ] || { echo "no NDK at $AB/android-ndk-r27c: run src/remote/callrec/callcap/setup.sh first" >&2; exit 1; }

"$CC" -std=c11 -Os -Wall -Wextra -s "$HERE/keystate.c" -o "$OUT"
ls -la "$OUT"
