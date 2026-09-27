#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UI="$HERE/../../userinit"
ZIG="${ZIG:-zig}"
CC=("$ZIG" cc -target arm-linux-musleabihf -static -Os -s)

"${CC[@]}" "$HERE/kaicap.c"   -o "$UI/bin/kaicap"
"${CC[@]}" "$HERE/drmprops.c" -o "$UI/bin/drmprops"
"${CC[@]}" "$HERE/callrecd.c" -o "$UI/services/callrec/callrecd"
ls -la "$UI/bin/kaicap" "$UI/bin/drmprops" "$UI/services/callrec/callrecd"
