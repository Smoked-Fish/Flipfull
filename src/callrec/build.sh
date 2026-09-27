#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../userinit/services/callrec"
R8="${R8:-$HOME/r8.jar}"
[ -f "$R8" ] || { echo "r8.jar not found (set R8=...); see the top of this script" >&2; exit 1; }
JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
javac --release 11 -d "$TMP/sdk" $(find "$HERE/sdk" -name '*.java')
javac --release 11 -cp "$TMP/sdk" -d "$TMP/classes" "$HERE/CallRec.java"
(cd "$TMP/sdk" && jar cf "$TMP/sdk.jar" .)
java -cp "$R8" com.android.tools.r8.D8 --release --min-api 34 \
    --lib "$JAVA_HOME" --lib "$TMP/sdk.jar" --output "$TMP" "$TMP"/classes/*.class
mkdir -p "$OUT"
cp "$TMP/classes.dex" "$OUT/callrec.dex"
ls -la "$OUT/callrec.dex"
