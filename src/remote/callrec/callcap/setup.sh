#!/usr/bin/env bash
set -euo pipefail

AB="${AB:-$HOME/ab}"
TAG=android-14.0.0_r75
NDK_URL=https://dl.google.com/android/repository/android-ndk-r27c-linux.zip
NDK_SHA1=090e8083a715fdb1a3e402d0763c388abb03fb4e
BT_URL=https://dl.google.com/android/repository/build-tools_r34-linux.zip
BT_SHA1=d6d58e0c6925a9e4d9a541e84cd1f405c2f9d2a9

mkdir -p "$AB/aosp"
cd "$AB"

fetch() { # name url sha1 dir
    if [ ! -d "$4" ]; then
        curl -sSL -o "$1.zip" "$2"
        echo "$3  $1.zip" | sha1sum -c -
        unzip -q "$1.zip"
    fi
}
fetch ndk "$NDK_URL" "$NDK_SHA1" android-ndk-r27c
fetch bt "$BT_URL" "$BT_SHA1" android-14

clone() { # repo dir paths...
    repo=$1; dir=$2; shift 2
    [ -d "aosp/$dir/.git" ] || git clone -q --depth 1 --filter=blob:none --sparse --branch "$TAG" \
        "https://android.googlesource.com/platform/$repo" "aosp/$dir" 2>/dev/null
    git -C "aosp/$dir" sparse-checkout set "$@"
}
clone frameworks/av av include aidl media
clone frameworks/native native include libs/binder libs/permission libs/nativebase libs/ui
clone system/core core libutils libcutils libsystem libprocessgroup libbacktrace include
clone system/logging logging liblog
clone system/media media audio audio_utils audio_effects
clone system/libbase libbase include
clone system/hardware/interfaces syshw media/aidl
clone hardware/libhardware hw include include_all

AIDL="$AB/android-14/aidl"
H="$AB/aidl_h"
rm -rf "$H" "$AB/gen"
cp -r "$AB/aosp/syshw/media/aidl" "$H"
grep -rl SuppressWarnings "$H" | xargs sed -i '/@SuppressWarnings(value={"redundant-name"})/d'
sed -i 's|float\[6\] headToStage = {[^}]*};|@nullable float[] headToStage;|' "$H/android/media/audio/common/HeadTracking.aidl"
mkdir -p "$AB/gen/include" "$AB/gen/src"
AV="$AB/aosp/av"
INC=(-I"$AV/media/libaudioclient/aidl" -I"$H" -I"$AB/aosp/native/libs/permission/aidl" -I"$AB/aosp/native/libs/binder/aidl"
     -I"$AV/aidl" -I"$AV/media/libshmem/aidl" -I"$AV/media/libmediametrics/aidl")
gen() {
    extra=()
    case "$1" in "$H"/*) extra=(--structured --stability vintf) ;; esac
    "$AIDL" --lang=cpp "${extra[@]}" "${INC[@]}" -o "$AB/gen/src" -h "$AB/gen/include" "$1"
}
for f in $(find "$AV/media/libaudioclient/aidl" "$AV/aidl" "$AV/media/libshmem/aidl" "$H/android/media/audio/common" \
        -name '*.aidl' ! -name IHalAdapterVendorExtension.aidl); do
    gen "$f"
done
gen "$AB/aosp/native/libs/permission/aidl/android/content/AttributionSourceState.aidl"
echo "headers generated: $(find "$AB/gen/include" -name '*.h' | wc -l)"
