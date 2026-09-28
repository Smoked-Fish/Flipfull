#!/bin/sh
set -e
cd "$(dirname "$0")"

if [ -z "$ADB" ]; then
    if command -v adb >/dev/null 2>&1; then
        ADB=adb
    elif [ -x platform-tools/adb ]; then
        ADB=platform-tools/adb
    else
        echo "adb not found: install Android's platform-tools, or put its folder next to this file"
        exit 1
    fi
fi
STAGING=/data/local/tmp/flipfull-setup

echo "Waiting for the phone (USB debugging on, this computer allowed)..."
"$ADB" wait-for-device
"$ADB" root >/dev/null
"$ADB" wait-for-device
if [ "$("$ADB" shell id -u | tr -d '\r')" != 0 ]; then
    echo "adb can't get root on this phone. Flipfull needs a rooted phone."
    exit 1
fi

echo "Copying Flipfull to the phone..."
"$ADB" shell rm -rf "$STAGING"
"$ADB" push flipfull "$STAGING" >/dev/null
"$ADB" shell sh "$STAGING/flipfull" setup --from "$STAGING"
"$ADB" shell rm -rf "$STAGING"
echo
echo "Done. Open Flipfull on the phone, pick what you want, then reboot."
