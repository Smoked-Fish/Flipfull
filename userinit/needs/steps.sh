STEPS=$USERINIT/steps

step_status() {
    if [ -f "$STEPS/post-fs-data/$1.sh" ] || [ -f "$STEPS/boot-completed/$1.sh" ]; then
        echo boot
    else
        echo "not on the phone"
        return 1
    fi
}

# steps/STAGE/NAME.sh runs at that stage of the boot while a feature that's on names it
step_apply() {
    case $1 in post-fs-data|boot-completed) ;; *) return 0 ;; esac
    for _step in $(wanted step "$2"); do
        [ -f "$STEPS/$1/$_step.sh" ] || continue
        (LOG_TAG=$_step; . "$STEPS/$1/$_step.sh")
    done
}

# mounts a file over each phone file that's there and has nothing mounted on it yet
bind_over() {
    _src=$1
    shift
    for _dst; do
        [ -f "$_dst" ] || continue
        if mounted_on "$_dst"; then
            log "$_dst already has something mounted on it - skipped"
        elif mount -o bind "$_src" "$_dst"; then
            log "${_src##*/} mounted over $_dst"
        else
            log "mount over $_dst failed - stock file in use"
        fi
    done
}

# a phone file changed by sed through a mounted copy; a second edit of the same file changes the copy
edit_file() {
    _copy=$STATE/$(echo "${1#/}" | tr / _)
    if same_file "$1" "$_copy"; then
        sed "$2" "$_copy" > "$_copy.tmp" && cat "$_copy.tmp" > "$_copy"
        rm -f "$_copy.tmp"
        log "$1 changed"
        return 0
    fi
    if mounted_on "$1"; then
        log "$1 already has something mounted on it - skipping"
        return 1
    fi
    mkdir -p "$STATE"
    sed "$2" "$1" > "$_copy" || return 1
    if cmp -s "$1" "$_copy"; then
        log "$1 already says so"
        return 0
    fi
    chown "$(stat -c %u:%g "$1")" "$_copy"
    chmod "$(stat -c %a "$1")" "$_copy"
    _ctx=$(ls -Z "$1" 2>/dev/null | awk '{ print $1 }')
    case $_ctx in u:object_r:*) chcon "$_ctx" "$_copy" ;; esac
    if mount -o bind "$_copy" "$1"; then
        log "bind-mounted $_copy over $1"
    else
        log "mount over $1 failed - stock file in use"
        return 1
    fi
}

stop_service() {
    _was=$(getprop "init.svc.$1")
    case $_was in
        '') log "$1: no such service" ;;
        stopped) log "$1: already stopped" ;;
        *) stop "$1" && log "$1: stopped (was $_was)" ;;
    esac
}

# the copy in the boot folder of the phone's storage wins over userinit/media
boot_media() {
    if [ -e "$USERINIT/media/disabled" ]; then
        log "media/disabled exists - stock $1" >&2
        return 1
    fi
    for _f in "/data/media/boot/$1" "$USERINIT/media/$1"; do
        if [ -s "$_f" ]; then
            echo "$_f"
            return 0
        fi
    done
    log "$1 missing - stock one in use" >&2
    return 1
}
