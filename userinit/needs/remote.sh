REMOTE=$API_DAEMON/remote
REMOTE_REGISTRY=$API_DAEMON/remote_services.toml

remote_status() {
    if [ ! -f "$USERINIT/remote/$1/daemon" ]; then
        echo "not on the phone"
        return 1
    elif grep -q "^$1 *=" "$REMOTE_REGISTRY" 2>/dev/null; then
        echo now
    else
        echo reboot
    fi
}

remote_apply() {
    case $1 in
        post-fs-data)
            remote_install
            remote_remove ;;
        setup)
            remote_install live
            remote_remove ;;
        uninstall) remote_remove all ;;
    esac
}

remote_install() {
    mkdir -p "$REMOTE" && chmod 0755 "$REMOTE" || return 1
    for _src in "$USERINIT"/remote/*/daemon; do
        [ -f "$_src" ] || continue
        _name=${_src%/daemon}
        _name=${_name##*/}
        _dst=$REMOTE/$_name
        cmp -s "$_src" "$_dst/daemon" && continue
        _later=
        [ "$1" = live ] && [ ! -d "$_dst" ] && _later=" - api-daemon uses it from the next boot"
        if mkdir -p "$_dst" && cp "$_src" "$_dst/daemon.tmp" && chmod 0755 "$_dst/daemon.tmp" &&
            mv -f "$_dst/daemon.tmp" "$_dst/daemon"; then
            log "installed $_name$_later"
            pkill -f "^$_dst/daemon" 2>/dev/null
        else
            log "error: couldn't install $_name"
        fi
        chcon -R u:object_r:api_data_file:s0 "$_dst" 2>/dev/null
    done
    _dir=$(http_root)/flipfull
    mkdir -p "$_dir" || return 1
    for _js in "$USERINIT"/remote/*.js; do
        [ -f "$_js" ] || continue
        _to=$_dir/${_js##*/}
        cmp -s "$_js" "$_to" && continue
        cp "$_js" "$_to.tmp" && chmod 0644 "$_to.tmp" && mv -f "$_to.tmp" "$_to" ||
            log "error: couldn't copy ${_js##*/} to $_dir"
    done
}

remote_remove() {
    for _dst in "$REMOTE"/Flipfull*; do
        [ -d "$_dst" ] || continue
        [ "$1" != all ] && [ -f "$USERINIT/remote/${_dst##*/}/daemon" ] && continue
        rm -rf "$_dst" && log "removed ${_dst##*/}"
    done
}
