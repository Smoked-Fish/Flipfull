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

LABEL_FROM=$SERVED
[ -f "$LABEL_FROM" ] || LABEL_FROM=$ORIGINAL
CTX=$(ls -Z "$LABEL_FROM" 2>/dev/null | awk '{print $1}')
case "$CTX" in
    u:object_r:*) label_system_file "$SRC" "$CTX" ;;
    *) label_system_file "$SRC" ;;
esac

mounted=0
for DST in "$SERVED" "$ORIGINAL"; do
    if [ ! -f "$DST" ]; then
        log "$DST not found - skipped"
        continue
    fi
    if mounted_on "$DST"; then
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
