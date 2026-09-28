#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=ads-stub

if ! planned feature ad-block on; then
    log "ad-block is off - real ads SDK in use"
    exit 0
fi

SRC="$USERINIT/etc/ads-sdk-stub.js"
SERVED=/data/local/service/api-daemon/http_root/sdk/ads/ads-sdk.min.js
ORIGINAL=/system/kaios/http_root/sdk/ads/ads-sdk.min.js

if [ ! -s "$SRC" ]; then
    log "$SRC missing - real ads SDK in use"
    exit 0
fi

chmod 0644 "$SRC" 2>/dev/null
chown root:root "$SRC" 2>/dev/null
LABEL_FROM=$SERVED
[ -f "$LABEL_FROM" ] || LABEL_FROM=$ORIGINAL
CTX=$(ls -Z "$LABEL_FROM" 2>/dev/null | awk '{print $1}')
case "$CTX" in
    u:object_r:*) chcon "$CTX" "$SRC" 2>/dev/null ;;
    *) chcon u:object_r:system_file:s0 "$SRC" 2>/dev/null ;;
esac

mounted=0
for DST in "$SERVED" "$ORIGINAL"; do
    if [ ! -f "$DST" ]; then
        log "$DST not found - skipped"
        continue
    fi
    if grep -qs " $DST " /proc/mounts; then
        log "$DST already has something mounted on it - skipped"
        continue
    fi
    if mount -o bind "$SRC" "$DST"; then
        log "stub mounted over $DST${CTX:+ ($CTX)}"
        mounted=1
    else
        log "mount over $DST failed"
    fi
done
[ "$mounted" = 1 ] || log "real ads SDK in use"
exit 0
