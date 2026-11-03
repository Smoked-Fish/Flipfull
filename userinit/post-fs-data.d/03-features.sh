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

if [ -s "$BOOT_PLAN" ] && [ ! -e "$STATE/replan" ] && [ ! "$REGISTRY" -nt "$BOOT_PLAN" ] &&
    [ ! "$CHOICES" -nt "$BOOT_PLAN" ] && [ ! "$SERVICES_INI" -nt "$BOOT_PLAN" ] &&
    [ ! "$PLAN_AWK" -nt "$BOOT_PLAN" ]; then
    REUSED=1
elif plan > "$BOOT_PLAN.tmp" && [ -s "$BOOT_PLAN.tmp" ]; then
    mv -f "$BOOT_PLAN.tmp" "$BOOT_PLAN"
    rm -f "$STATE/replan"
    REUSED=0
else
    rm -f "$BOOT_PLAN.tmp"
    : > "$BOOT_PLAN"
    log "couldn't work out which features are on - nothing is applied this boot"
    REUSED=0
fi
PLAN=$(cat "$BOOT_PLAN")
ON=
while read -r _k _id _st; do
    [ "$_k $_st" = "feature on" ] && ON="$ON$_id "
done < "$BOOT_PLAN"
log "on: $ON$([ $REUSED = 1 ] && echo '(plan from the last boot)')"
if [ $REUSED = 1 ] && [ -f "$STATE/features" ] && [ -f "$(http_root)/flipfull/features.js" ]; then
    :
elif publish "$PLAN"; then
    log "wrote features.js"
else
    log "couldn't write features.js - the overlays behave like the stock apps"
fi
needs_apply post-fs-data "$PLAN"
exit 0
