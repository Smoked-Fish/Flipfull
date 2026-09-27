#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=ads-stub

SRC="$USERINIT/etc/ads-sdk-stub.js"
DST=/system/kaios/http_root/sdk/ads/ads-sdk.min.js

if [ ! -s "$SRC" ]; then
    log "$SRC missing - real ads SDK in use"
    exit 0
fi
if [ ! -f "$DST" ]; then
    log "$DST not found - nothing to replace"
    exit 0
fi
if grep -qs " $DST " /proc/mounts; then
    log "$DST already has something mounted on it - skipping"
    exit 0
fi

chmod 0644 "$SRC" 2>/dev/null
chown root:root "$SRC" 2>/dev/null
CTX=$(ls -Z "$DST" 2>/dev/null | awk '{print $1}')
case "$CTX" in
    u:object_r:*) chcon "$CTX" "$SRC" 2>/dev/null ;;
    *) chcon u:object_r:system_file:s0 "$SRC" 2>/dev/null ;;
esac

if mount -o bind "$SRC" "$DST"; then
    log "stub mounted over $DST${CTX:+ ($CTX)}"
else
    log "mount failed - real ads SDK in use"
    exit 1
fi
