#!/usr/bin/env bash

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UI="$HERE/../../userinit"

ZIG="${ZIG:-zig}"
ARCH="${1:-32}"

case "$ARCH" in
    32)
        TARGET="arm-linux-musleabihf"
        CC=("$ZIG" cc -target "$TARGET" -static -Os -s)
        ;;

    64)
        TARGET="aarch64-linux-musl"
        CC=("$ZIG" cc -target "$TARGET" -mcpu=generic -static -Os -s)
        ;;

    *)
        echo "Usage: $0 [32|64]"
        echo
        echo "  32  Build 32-bit ARM (default)"
        echo "  64  Build 64-bit ARM (AArch64)"
        exit 1
        ;;
esac

echo "Building for ARM${ARCH}..."
echo "Zig target: $TARGET"

"${CC[@]}" "$HERE/kaicap.c" \
    -o "$UI/bin/kaicap"

"${CC[@]}" "$HERE/callrecd.c" \
    -o "$UI/services/callrec/callrecd"

echo
echo "Built:"

ls -la \
    "$UI/bin/kaicap" \
    "$UI/services/callrec/callrecd"

echo

file \
    "$UI/bin/kaicap" \
    "$UI/services/callrec/callrecd"