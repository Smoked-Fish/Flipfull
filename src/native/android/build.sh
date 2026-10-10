#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AB="${AB:-$HOME/ab}"
OUT="${OUT:-$HERE/../../../userinit/bin/callcap}"
NDK="$AB/android-ndk-r27c/toolchains/llvm/prebuilt/linux-x86_64"
CXX="$NDK/bin/armv7a-linux-androideabi34-clang++"
A="$AB/aosp"
DEVLIBS="$AB/devlibs"
LIBS=(libaudioclient libbinder libutils libcutils liblog framework-permission-aidl-cpp)

[ -x "$CXX" ] && [ -d "$AB/gen/include" ] || { echo "run src/native/android/setup.sh first" >&2; exit 1; }

mkdir -p "$DEVLIBS"
for l in "${LIBS[@]}"; do
    [ -f "$DEVLIBS/$l.so" ] || adb pull "/system/lib/$l.so" "$DEVLIBS/$l.so" > /dev/null
done

INCS=(
    -I"$AB/gen/include"
    -I"$A/av/include" -I"$A/native/include" -I"$A/native/libs/binder/include"
    -I"$A/native/libs/permission/include" -I"$A/native/libs/nativebase/include" -I"$A/native/libs/ui/include"
    -I"$A/core/libutils/include" -I"$A/core/libcutils/include" -I"$A/core/libsystem/include"
    -I"$A/core/libprocessgroup/include" -I"$A/core/include" -I"$A/logging/liblog/include"
    -I"$A/media/audio/include" -I"$A/media/audio_utils/include" -I"$A/media/audio_effects/include"
    -I"$A/hw/include" -I"$A/libbase/include"
)
while IFS= read -r d; do INCS+=(-I"$d"); done < <(find "$A/av/media" -maxdepth 4 -type d -name include \
    -not -path '*/codec2/*' -not -path '*/libstagefright/*' | sort)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$CXX" -std=c++20 -Os -Wall -fno-rtti -Wno-unused-parameter -Wno-c99-designator -Wno-deprecated-declarations \
    -Wno-inconsistent-missing-override -Wno-deprecated-anon-enum-enum-conversion \
    "${INCS[@]}" -c "$HERE/../callcap.cpp" -o "$TMP/callcap.o"
"$CXX" -s -static-libstdc++ -Wl,--allow-shlib-undefined "$TMP/callcap.o" \
    -L"$DEVLIBS" -laudioclient -l:framework-permission-aidl-cpp.so -lbinder -lutils -lcutils -llog -lmediandk \
    -o "$OUT"
ls -la "$OUT"
file "$OUT"
