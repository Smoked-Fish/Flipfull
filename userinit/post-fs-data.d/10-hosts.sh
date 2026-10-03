#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=hosts

SRC="$USERINIT/state/hosts"
DST=/system/etc/hosts

LISTS=$(awk '$1 == "hosts" { print $2 }' "$BOOT_PLAN" 2>/dev/null)
if [ -z "$LISTS" ]; then
    log "no feature blocks anything - stock hosts in use"
    exit 0
fi
if grep -qs " $DST " /proc/mounts; then
    log "$DST already has something mounted on it - skipping"
    exit 0
fi

{
    cat "$USERINIT/etc/hosts.d/base.hosts"
    for g in $LISTS; do
        cat "$USERINIT/etc/hosts.d/$g.hosts" || log "etc/hosts.d/$g.hosts missing" >&2
    done
} | awk 'NF && $1 !~ /^#/ { print }' | sort -u > "$SRC"

chmod 0644 "$SRC" 2>/dev/null
chown root:root "$SRC" 2>/dev/null
chcon u:object_r:system_file:s0 "$SRC" 2>/dev/null

if mount -o bind "$SRC" "$DST"; then
    log "bind-mounted $SRC over $DST: base" $LISTS
else
    log "mount failed - stock hosts still in use"
    exit 1
fi
