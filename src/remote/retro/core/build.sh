#!/usr/bin/env bash
# mgba only builds the libretro core as a shared lib, so the objects go in an archive

set -euo pipefail

OUT="${1:?usage: build.sh OUT}"
ZIG="${ZIG:-zig}"
CACHE="${CACHE:-$HOME/.cache/flipfull}"
MG="${MGBA:-$CACHE/mgba}"
MGBA_COMMIT=26b7884bc25a5933960f3cdcd98bac1ae14d42e2
OBJ="${OBJ:-$CACHE/mgba-obj}"
CMAKE="${CMAKE:-cmake}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

if [ "$(git -C "$MG" rev-parse HEAD 2>/dev/null)" != "$MGBA_COMMIT" ]; then
  echo "Fetching mGBA $MGBA_COMMIT into $MG..."
  mkdir -p "$MG"
  git -C "$MG" init -q
  git -C "$MG" fetch -q --depth 1 https://github.com/mgba-emu/mgba.git "$MGBA_COMMIT"
  git -C "$MG" checkout -q --force FETCH_HEAD
fi

# built for the a78s, the game thread stays on them
CPU="-target aarch64-linux-musl -mcpu=cortex_a78"
ZIG="$(command -v "$ZIG")"
mkdir -p "$OBJ/zig" "$OUT"
for tool in cc ar ranlib; do
  case $tool in cc) flags=$CPU ;; *) flags="" ;; esac
  printf '#!/bin/sh\nexec "%s" %s %s "$@"\n' "$ZIG" "$tool" "$flags" > "$OBJ/zig/$tool"
  chmod +x "$OBJ/zig/$tool"
done

# only gba and gb, no debuggers, scripting or gl
"$CMAKE" -S "$MG" -B "$OBJ/build" -G Ninja -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_LINK_DEPENDS_USE_LINKER=OFF \
  -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER="$OBJ/zig/cc" -DCMAKE_AR="$OBJ/zig/ar" -DCMAKE_RANLIB="$OBJ/zig/ranlib" \
  -DCMAKE_C_FLAGS="-fno-sanitize=all -ffunction-sections -fdata-sections" \
  -DBUILD_LIBRETRO=ON -DSKIP_LIBRARY=ON -DBUILD_SHARED=OFF -DBUILD_STATIC=OFF \
  -DBUILD_QT=OFF -DBUILD_SDL=OFF -DBUILD_GL=OFF -DBUILD_GLES2=OFF -DBUILD_GLES3=OFF -DBUILD_LTO=OFF \
  -DDISABLE_DEPS=ON -DM_CORE_GB=ON -DUSE_DEBUGGERS=OFF -DUSE_GDB_STUB=OFF -DUSE_EDITLINE=OFF \
  -DENABLE_SCRIPTING=OFF -DUSE_DISCORD_RPC=OFF >/dev/null
"$CMAKE" --build "$OBJ/build" -j "$JOBS" --target mgba_libretro

objs=()
while IFS= read -r o; do objs+=("$o"); done < <(find "$OBJ/build/CMakeFiles/mgba_libretro.dir" -name '*.o' | sort)
[[ ${#objs[@]} -gt 50 ]] || { echo "mgba_libretro's objects not found in $OBJ/build" >&2; exit 1; }
rm -f "$OUT/libmgba_retro.a"
"$ZIG" ar rcs "$OUT/libmgba_retro.a" "${objs[@]}"
ls -la "$OUT"
