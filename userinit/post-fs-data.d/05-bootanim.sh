#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=bootanim

SRC_DIR="$USERINIT/media"
SYS=/system/media

if [ -e "$SRC_DIR/disabled" ]; then
    log "$SRC_DIR/disabled exists - stock boot animation and sound"
    exit 0
fi

mount_over() {
    src="$SRC_DIR/$1"; shift
    if [ ! -s "$src" ]; then
        log "${src##*/} missing - $* stay stock"
        return
    fi
    chmod 0644 "$src" 2>/dev/null
    chown root:root "$src" 2>/dev/null
    chcon u:object_r:system_file:s0 "$src" 2>/dev/null
    for name in "$@"; do
        dst="$SYS/$name"
        [ -f "$dst" ] || continue
        if grep -qs " $dst " /proc/mounts; then
            log "$dst already has something mounted on it - skipped"
        elif mount -o bind "$src" "$dst"; then
            log "${src##*/} mounted over $dst"
        else
            log "mount over $dst failed - stock file in use"
        fi
    done
}

mount_over bootanimation.zip bootanimation.zip bootanimation_metro.zip bootanimation_tcl.zip
mount_over bootanimation_external.zip \
    bootanimation_external.zip bootanimation_external_mpcs.zip bootanimation_external_tcl.zip
mount_over poweron-sound.wav poweron-sound.wav poweron-sound_metro.wav poweron-sound_tcl.ogg
exit 0
