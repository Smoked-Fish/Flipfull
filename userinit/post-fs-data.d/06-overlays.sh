#!/system/bin/sh

. /data/local/userinit/lib/common.sh
. "$USERINIT/lib/overlays.sh"
LOG_TAG=overlays

HTTP_CACHE=/data/cache/cache2
MOUNTED="$USERINIT/state/overlays-mounted"
overlays_read

PLANNED=$(awk '$1 == "overlay" { print $2 }' "$BOOT_PLAN" 2>/dev/null)
has_line "$PLANNED" system && PLANNED="system $PLANNED"

TODO=""
NOW=""
SEEN=" "
for NAME in $PLANNED; do
    case $SEEN in *" $NAME "*) continue ;; esac
    SEEN="$SEEN$NAME "
    HOW=$(overlay_check "$NAME")
    case $HOW in
        mount)
            SRC="$USERINIT/overlays/$NAME"
            TODO="$TODO$NAME $SRC $(overlay_target "$NAME")
"
            NOW="$NOW$NAME $(stat -c '%i %s %Y' "$SRC/application.zip") " ;;
        mounted) log "$NAME: already mounted" ;;
        app) log "$NAME: not an app the phone came with, installed as an app instead" ;;
        *) log "$NAME: $HOW - not mounted" ;;
    esac
done

if [ "$NOW" != "$(cat "$MOUNTED" 2>/dev/null)" ]; then
    rm -rf "$HTTP_CACHE"
    log "overlays changed since the last boot - cleared b2g's HTTP cache ($HTTP_CACHE)"
    echo "$NOW" > "$MOUNTED"
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
