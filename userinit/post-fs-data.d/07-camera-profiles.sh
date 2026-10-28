#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=camera

BLOCK="$USERINIT/etc/camera/profiles.xml"
OPEN='<CamcorderProfiles cameraId="0">'

if ! planned feature camera-rework on; then
    log "camera-rework is off - stock video profiles"
    exit 0
fi

for dst in /vendor/etc/media_profiles*.xml; do
    [ -f "$dst" ] || continue
    if mounted_on "$dst"; then
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
    label_system_file "$src" u:object_r:vendor_configs_file:s0
    if mount -o bind "$src" "$dst"; then
        log "camera profiles mounted over $dst"
    else
        log "mount over $dst failed - stock profiles"
    fi
done
exit 0
