#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UI="$HERE/../../userinit"
ZIG="${ZIG:-zig}"
CC=("$ZIG" cc -target arm-linux-musleabihf -static -Os -s)

"${CC[@]}" "$HERE/ttlfix.c"   -o "$UI/services/tether-ttl/ttlfix"
"${CC[@]}" "$HERE/kaicap.c"   -o "$UI/bin/kaicap"
"${CC[@]}" "$HERE/drmprops.c" -o "$UI/bin/drmprops"
ls -la "$UI/services/tether-ttl/ttlfix" "$UI/bin/kaicap" "$UI/bin/drmprops"
