#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=overlays

VROOT=/data/local/webapps/vroot

for SRC in "$USERINIT"/overlays/*; do
    [ -d "$SRC" ] || continue
    NAME=${SRC##*/}
    if [ -e "$SRC/disabled" ]; then
        log "$NAME: disabled - stock app in use"
        continue
    fi
    if [ ! -f "$SRC/application.zip" ]; then
        log "$NAME: no application.zip - skipped"
        continue
    fi
    DST=$(readlink -f "$VROOT/$NAME" 2>/dev/null)
    if [ -z "$DST" ] || [ ! -d "$DST" ]; then
        log "$NAME: no stock app at $VROOT/$NAME - skipped"
        continue
    fi
    if grep -qs " $DST " /proc/mounts; then
        log "$NAME: $DST already has something mounted on it - skipped"
        continue
    fi

    chmod 0755 "$SRC"
    chmod 0644 "$SRC"/* 2>/dev/null
    CTX=$(ls -Zd "$DST" 2>/dev/null | awk '{print $1}')
    case "$CTX" in
        u:object_r:*) chcon -R "$CTX" "$SRC" 2>/dev/null ;;
    esac

    if mount -o bind "$SRC" "$DST"; then
        log "$NAME: mounted over $DST${CTX:+ ($CTX)}"
    else
        log "$NAME: mount failed - stock app in use"
    fi
done
exit 0
