PREFS_BLOCK='/^\/\/ >>> userinit/,/\/\/ <<< userinit$/'

prefs_status() {
    if [ -f "$USERINIT/etc/prefs.d/$1.js" ]; then
        echo ui
    else
        echo "not on the phone"
        return 1
    fi
}

pref_names() {
    grep -o 'user_pref([[:space:]]*"[^"]*"' | sed 's/^user_pref([[:space:]]*"//; s/"$//'
}

prefs_apply() {
    case $1 in post-fs-data|ui|uninstall) ;; *) return 0 ;; esac
    _prefs=$STATE/user-prefs.js
    mkdir -p "$STATE"
    for _g in $(wanted prefs "$2"); do
        if [ -f "$USERINIT/etc/prefs.d/$_g.js" ]; then
            awk 1 "$USERINIT/etc/prefs.d/$_g.js"
        else
            log "prefs: etc/prefs.d/$_g.js missing" >&2
        fi
    done > "$_prefs"
    _new=$(pref_names < "$_prefs")
    _found=0
    for _profile in /data/b2g/mozilla/*.default; do
        [ -d "$_profile" ] || continue
        _found=1
        _f=$_profile/user.js
        _old=
        if [ -f "$_f" ]; then
            # NUL bytes in user.js make Gecko skip all of it, and the phone's awk cuts lines at them
            tr -d '\000' < "$_f" > "$_f.tmp"
            cmp -s "$_f" "$_f.tmp" || { cat "$_f.tmp" > "$_f" && log "prefs: took NUL bytes out of $_f"; }
            rm -f "$_f.tmp"
            _old=$(sed -n "${PREFS_BLOCK}p" "$_f" | pref_names)
            sed -i "${PREFS_BLOCK}d" "$_f"
        fi
        for _name in $_old; do
            echo "$_new" | grep -qxF "$_name" && continue
            _esc=$(echo "$_name" | sed 's/[.[\*^$/]/\\&/g')
            if grep -q "^user_pref(\"$_esc\"," "$_profile/prefs.js" 2>/dev/null; then
                sed -i "/^user_pref(\"$_esc\",/d" "$_profile/prefs.js"
                log "prefs: $_name no longer managed, back to its default"
            fi
        done
        if [ "$1" = uninstall ]; then
            log "prefs: removed the managed block from $_f"
            continue
        fi
        if [ ! -s "$_prefs" ]; then
            log "prefs: no feature that's on sets Gecko prefs"
            continue
        fi
        if [ -s "$_f" ] && [ -n "$(tail -c1 "$_f")" ]; then
            echo >> "$_f"
        fi
        {
            echo "// >>> userinit: managed block, from $USERINIT/etc/prefs.d (features.ini)"
            cat "$_prefs"
            echo "// <<< userinit"
        } >> "$_f"
        log "prefs: wrote $(grep -c '^user_pref' "$_prefs") prefs to $_f"
    done
    [ "$_found" = 1 ] || log "prefs: no B2G profile yet - nothing to do"
}
