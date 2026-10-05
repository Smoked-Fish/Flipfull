#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=gecko-prefs

PREFS="$USERINIT/state/user-prefs.js"
BEGIN="// >>> userinit: managed block, from $USERINIT/etc/prefs.d (features.ini)"
END="// <<< userinit"

if [ "$1" != remove ]; then
    for g in $(awk '$1 == "prefs" { print $2 }' "$BOOT_PLAN" 2>/dev/null); do
        if [ -f "$USERINIT/etc/prefs.d/$g.js" ]; then
            awk 1 "$USERINIT/etc/prefs.d/$g.js"
        else
            log "etc/prefs.d/$g.js missing" >&2
        fi
    done > "$PREFS"
fi

pref_names() {
    grep -o 'user_pref([[:space:]]*"[^"]*"' | sed 's/^user_pref([[:space:]]*"//; s/"$//'
}

BLOCK='/^\/\/ >>> userinit/,/\/\/ <<< userinit$/'

found=0
for profile in /data/b2g/mozilla/*.default; do
    [ -d "$profile" ] || continue
    found=1
    f="$profile/user.js"
    old=""
    if [ -f "$f" ]; then
        old=$(sed -n "${BLOCK}p" "$f" | pref_names)
        sed -i "${BLOCK}d" "$f"
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
        log "no feature that's on sets Gecko prefs"
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
