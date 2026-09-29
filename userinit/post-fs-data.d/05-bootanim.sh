#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=bootanim

SRC_DIR="$USERINIT/media"
BOOT_DIR=/data/media/boot
SYS=/system/media

if [ -e "$SRC_DIR/disabled" ]; then
    log "$SRC_DIR/disabled exists - stock boot animation and sound"
    exit 0
fi

mount_over() {
    case "$1" in
        /*) src="$1" ;;
        *)  src="$SRC_DIR/$1" ;;
    esac
    shift
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

# the copy in the boot folder wins
pick() {
    if [ -s "$BOOT_DIR/$1" ]; then
        echo "$BOOT_DIR/$1"
    else
        echo "$SRC_DIR/$1"
    fi
}

if planned feature boot-animation on; then
    mount_over "$(pick bootanimation.zip)" \
        bootanimation.zip bootanimation_metro.zip bootanimation_tcl.zip
    mount_over "$(pick bootanimation_external.zip)" \
        bootanimation_external.zip bootanimation_external_mpcs.zip bootanimation_external_tcl.zip
else
    log "boot-animation is off - stock boot animation"
fi
if planned feature boot-sound on; then
    mount_over poweron-sound.wav poweron-sound.wav poweron-sound_metro.wav poweron-sound_tcl.ogg
else
    log "boot-sound is off - stock boot sound"
fi
if planned feature boot-logo on; then
    mount_over "$BOOT_DIR/initlogo.png" initlogo.png
else
    log "boot-logo is off - stock start-up logo"
fi
exit 0