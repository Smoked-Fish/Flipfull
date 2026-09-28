#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=overlays

VROOT=/data/local/webapps/vroot
HTTP_CACHE=/data/cache/cache2
STATE="$USERINIT/state/overlays-mounted"
PRELOADED="
$(preloaded_apps)
"
MOUNTS=$(cat /proc/mounts)

PLANNED=$(awk '$1 == "overlay" { print $2 }' "$BOOT_PLAN" 2>/dev/null)
case "
$PLANNED
" in
    *"
system
"*) PLANNED="system $PLANNED" ;;
esac

TODO=""
NOW=""
SEEN=" "
for NAME in $PLANNED; do
    case $SEEN in *" $NAME "*) continue ;; esac
    SEEN="$SEEN$NAME "
    SRC="$USERINIT/overlays/$NAME"
    if [ -e "$SRC/disabled" ]; then
        log "$NAME: disabled - stock app in use"
        continue
    fi
    if [ ! -f "$SRC/application.zip" ]; then
        log "$NAME: no application.zip - skipped"
        continue
    fi
    case $PRELOADED in
        "

") ;; # apps db unreadable
        *"
$NAME
"*) ;;
        *)
            log "$NAME: not an app the phone came with - installed as an app instead"
            continue ;;
    esac
    DST=$(readlink -f "$VROOT/$NAME" 2>/dev/null)
    if [ -z "$DST" ] || [ ! -d "$DST" ]; then
        log "$NAME: no stock app at $VROOT/$NAME - skipped"
        continue
    fi
    case $MOUNTS in
        *" $DST "*)
            log "$NAME: $DST already has something mounted on it - skipped"
            continue ;;
    esac
    if ! stock_matches "$SRC" "$DST/application.zip"; then
        log "$NAME: the phone's $NAME app isn't the one this overlay was made from - stock app in use"
        continue
    fi
    TODO="$TODO$NAME $SRC $DST
"
    NOW="$NOW$NAME $(stat -c '%i %s %Y' "$SRC/application.zip") "
done

if [ "$NOW" != "$(cat "$STATE" 2>/dev/null)" ]; then
    rm -rf "$HTTP_CACHE"
    log "overlays changed since the last boot - cleared b2g's HTTP cache ($HTTP_CACHE)"
    echo "$NOW" > "$STATE"
fi

echo "$TODO" | while read -r NAME SRC DST; do
    [ -n "$NAME" ] || continue
    if mount -o bind "$SRC" "$DST"; then
        log "$NAME: mounted over $DST"
    else
        log "$NAME: mount failed - stock app in use"
    fi
done
exit 0
