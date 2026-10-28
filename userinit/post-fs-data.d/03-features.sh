#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=features
load_needs

if [ "$1" = uninstall ]; then
    rm -rf "$(http_root)/flipfull"
    needs_apply uninstall ""
    exit 0
fi

mkdir -p "$STATE"
if plan > "$BOOT_PLAN.tmp" && [ -s "$BOOT_PLAN.tmp" ]; then
    mv -f "$BOOT_PLAN.tmp" "$BOOT_PLAN"
else
    rm -f "$BOOT_PLAN.tmp"
    : > "$BOOT_PLAN"
    log "couldn't work out which features are on - nothing is applied this boot"
fi
log "on: $(awk '$1 == "feature" && $3 == "on" { printf "%s ", $2 }' "$BOOT_PLAN")"
if publish; then
    log "wrote features.js"
else
    log "couldn't write features.js - the overlays behave like the stock apps"
fi
needs_apply post-fs-data "$(cat "$BOOT_PLAN")"
exit 0
