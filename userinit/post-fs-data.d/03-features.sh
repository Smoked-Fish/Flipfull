#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=features

mkdir -p "$USERINIT/state"
if sh "$USERINIT/flipfull" plan > "$BOOT_PLAN.tmp" && [ -s "$BOOT_PLAN.tmp" ]; then
    mv -f "$BOOT_PLAN.tmp" "$BOOT_PLAN"
else
    rm -f "$BOOT_PLAN.tmp"
    : > "$BOOT_PLAN"
    log "couldn't work out which features are on - nothing is applied this boot"
fi
log "on: $(awk '$1 == "feature" && $3 == "on" { printf "%s ", $2 }' "$BOOT_PLAN")"
if sh "$USERINIT/flipfull" publish; then
    log "wrote features.js"
else
    log "couldn't write features.js - the overlays behave like the stock apps"
fi
exit 0
