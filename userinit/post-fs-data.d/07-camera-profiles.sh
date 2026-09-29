#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=camera

BLOCK="$USERINIT/etc/camera/profiles.xml"
OPEN='<CamcorderProfiles cameraId="0">'

if ! planned feature camera-frame-rates on; then
    log "camera-frame-rates is off - stock video profiles"
    exit 0
fi

# Gecko reads more than one of these (the variant files), so each gets its
# own back camera section swapped for etc/camera/profiles.xml
for dst in /vendor/etc/media_profiles*.xml; do
    [ -f "$dst" ] || continue
    if grep -qs " $dst " /proc/mounts; then
        log "$dst already has something mounted on it - skipped"
        continue
    fi
    if [ "$(grep -cF "$OPEN" "$dst")" != 1 ]; then
        log "$dst: no single back camera section - stock profiles"
        continue
    fi
    src="$USERINIT/state/${dst##*/}"
    awk -v block="$BLOCK" -v open="$OPEN" '
        index($0, open) { while ((getline line < block) > 0) print line; skip = 1; next }
        skip { if (index($0, "</CamcorderProfiles>")) skip = 0; next }
        { print }
    ' "$dst" > "$src"
    chmod 0644 "$src" 2>/dev/null
    chown root:root "$src" 2>/dev/null
    chcon u:object_r:vendor_configs_file:s0 "$src" 2>/dev/null
    if mount -o bind "$src" "$dst"; then
        log "camera profiles mounted over $dst"
    else
        log "mount over $dst failed - stock profiles"
    fi
done
exit 0
