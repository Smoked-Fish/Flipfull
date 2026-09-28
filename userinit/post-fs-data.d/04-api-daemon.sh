#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=api-daemon

DIR=/data/local/service/api-daemon

mount_changed() {
    copy=$USERINIT/state/api-daemon-${1##*/}
    if grep -qs " $1 " /proc/mounts; then
        log "$1 already has something mounted on it - skipping"
        return 1
    fi
    sed "$2" "$1" > "$copy" || return 1
    if cmp -s "$1" "$copy"; then
        log "$1 already says so"
        return 0
    fi
    chown root:root "$copy"
    chmod 0600 "$copy"
    chcon u:object_r:api_data_file:s0 "$copy" 2>/dev/null
    if mount -o bind "$copy" "$1"; then
        log "bind-mounted $copy over $1"
    else
        log "mount over $1 failed - api-daemon uses it as it is"
        return 1
    fi
}

if planned feature block-telemetry on; then
    mount_changed "$DIR/config.toml" '/^\[telemetry\]/,/^\[/s/^enabled *= *true/enabled = false/'
fi

if planned feature block-app-updates on; then
    f=$DIR/app-update-config.json
    if [ ! -f "$f" ]; then
        echo '{"enabled":true,"conn_type":"Any","delay":86400,"last_check":0}' > "$f"
        chmod 0600 "$f"
        chcon u:object_r:api_data_file:s0 "$f" 2>/dev/null
    fi
    mount_changed "$f" 's/"enabled":true/"enabled":false/'
fi
exit 0
