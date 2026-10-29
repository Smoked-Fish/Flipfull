block=$USERINIT/etc/camera/profiles.xml
open='<CamcorderProfiles cameraId="0">'

# Gecko reads more than one of these (the variant files), so each gets its
# own back camera section swapped for etc/camera/profiles.xml
for dst in /vendor/etc/media_profiles*.xml; do
    [ -f "$dst" ] || continue
    if [ "$(grep -cF "$open" "$dst")" != 1 ]; then
        log "$dst: no single back camera section - stock profiles"
        continue
    fi
    src=$STATE/${dst##*/}
    awk -v block="$block" -v open="$open" '
        index($0, open) { while ((getline line < block) > 0) print line; skip = 1; next }
        skip { if (index($0, "</CamcorderProfiles>")) skip = 0; next }
        { print }
    ' "$dst" > "$src"
    label_system_file "$src" u:object_r:vendor_configs_file:s0
    bind_over "$src" "$dst"
done
