#!/system/bin/sh
# shared-memory: Gecko autoconfig sets the one pref user.js can't, because it is locked
# etc/autoconfig/shared-memory.js runs before user.js and lockPref() unlocks, sets and relocks it

. /data/local/userinit/lib/common.sh
LOG_TAG=gecko-autoconfig

B2G=/system/b2g
CFG_SRC=$USERINIT/etc/autoconfig/shared-memory.js
CFG_AT=$B2G/removed-files
PREFS_AT=$B2G/defaults/pref/proc-prefs.js
PREFS_COPY=$STATE/proc-prefs.js

if ! planned feature shared-memory on; then
    log "shared-memory is off - autoconfig not set up"
    exit 0
fi

for f in "$CFG_SRC" "$CFG_AT" "$PREFS_AT"; do
    if [ ! -f "$f" ]; then
        log "$f missing - autoconfig not set up"
        exit 0
    fi
done
for f in "$CFG_AT" "$PREFS_AT"; do
    if grep -qs " $f " /proc/mounts; then
        log "$f already has something mounted on it - autoconfig not set up"
        exit 0
    fi
done

label() {
    chown root:root "$1"
    chmod 0644 "$1"
    chcon u:object_r:system_file:s0 "$1" 2>/dev/null
}

# sandbox_enabled so a broken autoconfig file is only a console warning
mkdir -p "$STATE"
{
    awk 1 "$PREFS_AT"
    echo '// >>> userinit: shared-memory autoconfig'
    echo 'pref("general.config.filename", "removed-files");'
    echo 'pref("general.config.obscure_value", 0);'
    echo 'pref("general.config.sandbox_enabled", true);'
    echo '// <<< userinit'
} > "$PREFS_COPY" || { log "could not write $PREFS_COPY"; exit 0; }
label "$CFG_SRC"
label "$PREFS_COPY"

if ! mount -o bind "$CFG_SRC" "$CFG_AT"; then
    log "mount over $CFG_AT failed - autoconfig not set up"
    exit 0
fi
if mount -o bind "$PREFS_COPY" "$PREFS_AT"; then
    log "autoconfig set up: $CFG_SRC on $CFG_AT, prefs on $PREFS_AT"
else
    umount "$CFG_AT"
    log "mount over $PREFS_AT failed - autoconfig not set up"
fi
exit 0
