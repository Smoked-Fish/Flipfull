AUTOCONFIG_AT=/system/b2g/removed-files
AUTOCONFIG_PREFS_AT=/system/b2g/defaults/pref/proc-prefs.js

autoconfig_status() {
    if [ ! -f "$USERINIT/etc/autoconfig.d/$1.js" ]; then
        echo "not on the phone"
        return 1
    fi
    if [ ! -f "$AUTOCONFIG_AT" ] || [ ! -f "$AUTOCONFIG_PREFS_AT" ]; then
        echo "the phone has no $AUTOCONFIG_AT to put Gecko's autoconfig on"
        return 1
    fi
    echo ui
}

# bind-mounted over two files b2g has but doesn't need
autoconfig_apply() {
    case $1 in post-fs-data|ui) ;; *) return 0 ;; esac
    _names=$(wanted autoconfig "$2")
    _ours=0
    same_file "$STATE/autoconfig.cfg" "$AUTOCONFIG_AT" && _ours=1
    if [ -z "$_names" ]; then
        if [ $_ours = 1 ]; then
            umount "$AUTOCONFIG_PREFS_AT"
            umount "$AUTOCONFIG_AT"
        fi
        log "autoconfig: no feature that's on needs it"
        return 0
    fi
    for _f in "$AUTOCONFIG_AT" "$AUTOCONFIG_PREFS_AT"; do
        if [ ! -f "$_f" ]; then
            log "autoconfig: $_f missing - not set up"
            return 0
        fi
        if [ $_ours = 0 ] && mounted_on "$_f"; then
            log "autoconfig: $_f already has something mounted on it - not set up"
            return 0
        fi
    done
    mkdir -p "$STATE"
    {
        echo "// Flipfull's autoconfig, from $USERINIT/etc/autoconfig.d (features.ini). Gecko skips this line."
        for _n in $_names; do
            if [ -f "$USERINIT/etc/autoconfig.d/$_n.js" ]; then
                awk 1 "$USERINIT/etc/autoconfig.d/$_n.js"
            else
                log "autoconfig: etc/autoconfig.d/$_n.js missing" >&2
            fi
        done
    } > "$STATE/autoconfig.cfg"
    if [ $_ours = 1 ]; then
        log "autoconfig: now" $_names
        return 0
    fi
    # sandbox_enabled so a broken autoconfig file is only a console warning
    {
        awk 1 "$AUTOCONFIG_PREFS_AT"
        echo '// >>> userinit: autoconfig'
        echo 'pref("general.config.filename", "removed-files");'
        echo 'pref("general.config.obscure_value", 0);'
        echo 'pref("general.config.sandbox_enabled", true);'
        echo '// <<< userinit'
    } > "$STATE/proc-prefs.js" || { log "autoconfig: couldn't write $STATE/proc-prefs.js"; return 0; }
    label_system_file "$STATE/autoconfig.cfg"
    label_system_file "$STATE/proc-prefs.js"
    if ! mount -o bind "$STATE/autoconfig.cfg" "$AUTOCONFIG_AT"; then
        log "autoconfig: mount over $AUTOCONFIG_AT failed - not set up"
        return 0
    fi
    if mount -o bind "$STATE/proc-prefs.js" "$AUTOCONFIG_PREFS_AT"; then
        log "autoconfig: set up with" $_names
    else
        umount "$AUTOCONFIG_AT"
        log "autoconfig: mount over $AUTOCONFIG_PREFS_AT failed - not set up"
    fi
}
