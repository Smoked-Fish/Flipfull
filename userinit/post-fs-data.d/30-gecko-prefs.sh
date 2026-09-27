#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=gecko-prefs

PREFS="$USERINIT/etc/user-prefs.js"
BEGIN="// >>> userinit: managed block, edit $PREFS instead"
END="// <<< userinit"

pref_names() {
    sed -n 's/^[[:space:]]*user_pref([[:space:]]*"\([^"]*\)".*/\1/p'
}

found=0
for profile in /data/b2g/mozilla/*.default; do
    [ -d "$profile" ] || continue
    found=1
    f="$profile/user.js"
    old=""
    if [ -f "$f" ]; then
        old=$(sed -n '/^\/\/ >>> userinit/,/^\/\/ <<< userinit/p' "$f" | pref_names)
        sed -i '/^\/\/ >>> userinit/,/^\/\/ <<< userinit/d' "$f"
    fi
    new=""
    [ "$1" != remove ] && [ -s "$PREFS" ] && new=$(pref_names < "$PREFS")
    for name in $old; do
        echo "$new" | grep -qxF "$name" && continue
        esc=$(echo "$name" | sed 's/[.[\*^$/]/\\&/g')
        if grep -q "^user_pref(\"$esc\"," "$profile/prefs.js" 2>/dev/null; then
            sed -i "/^user_pref(\"$esc\",/d" "$profile/prefs.js"
            log "$name: no longer managed, back to its default"
        fi
    done
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
