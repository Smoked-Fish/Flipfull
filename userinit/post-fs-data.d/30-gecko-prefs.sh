#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=gecko-prefs

PREFS="$USERINIT/etc/user-prefs.js"
BEGIN="// >>> userinit: managed block, edit $PREFS instead"
END="// <<< userinit"

found=0
for profile in /data/b2g/mozilla/*.default; do
    [ -d "$profile" ] || continue
    found=1
    f="$profile/user.js"
    [ -f "$f" ] && sed -i '/^\/\/ >>> userinit/,/^\/\/ <<< userinit/d' "$f"
    if [ "$1" = remove ]; then
        log "removed the managed block from $f"
        continue
    fi
    if [ ! -s "$PREFS" ]; then
        log "$PREFS missing or empty - no managed prefs"
        continue
    fi
    if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then
        echo >> "$f"
    fi
    { echo "$BEGIN"; cat "$PREFS"; echo "$END"; } >> "$f"
    log "wrote $(grep -c '^user_pref' "$PREFS") prefs to $f"
done
[ "$found" = 1 ] || log "no B2G profile yet - nothing to do"
exit 0
