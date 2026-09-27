#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=hosts

SRC="$USERINIT/etc/hosts"
DST=/system/etc/hosts

if [ ! -s "$SRC" ]; then
    log "$SRC missing or empty - stock hosts in use"
    exit 0
fi
if grep -qs " $DST " /proc/mounts; then
    log "$DST already has something mounted on it - skipping"
    exit 0
fi

chmod 0644 "$SRC" 2>/dev/null
chown root:root "$SRC" 2>/dev/null
chcon u:object_r:system_file:s0 "$SRC" 2>/dev/null

if mount -o bind "$SRC" "$DST"; then
    log "bind-mounted $SRC over $DST"
else
    log "mount failed - stock hosts still in use"
    exit 1
fi
