REMOTE=$API_DAEMON/remote
REMOTE_REGISTRY=$API_DAEMON/remote_services.toml

remote_status() {
    if [ ! -f "$USERINIT/remote/$1/daemon" ]; then
        echo "not on the phone"
        return 1
    elif grep -q "^$1 *=" "$REMOTE_REGISTRY" 2>/dev/null; then
        echo now
    else
        echo later
    fi
}

remote_apply() {
    case $1 in
        post-fs-data)
            remote_install missing
            remote_remove ;;
        ui)
            remote_install
            remote_remove ;;
        setup)
            remote_install
            remote_remove
            remote_register ;;
        uninstall) remote_remove all ;;
    esac
}

# api-daemon only finds new remote services as it starts
remote_register() {
    _new=
    for _d in "$REMOTE"/Flipfull*; do
        [ -d "$_d" ] || continue
        grep -q "^${_d##*/} *=" "$REMOTE_REGISTRY" 2>/dev/null || _new="$_new ${_d##*/}"
    done
    [ -n "$_new" ] || return 0
    api_daemon_restart
    log "restarted api-daemon so it has$_new"
}

remote_install() {
    if [ "$1" != missing ] || [ ! -d "$REMOTE" ]; then
        mkdir -p "$REMOTE" && chmod 0755 "$REMOTE" || return 1
    fi
    for _src in "$USERINIT"/remote/*/daemon; do
        [ -f "$_src" ] || continue
        _name=${_src%/daemon}
        _name=${_name##*/}
        _dst=$REMOTE/$_name
        [ "$1" = missing ] && [ -f "$_dst/daemon" ] && continue
        cmp -s "$_src" "$_dst/daemon" && continue
        if mkdir -p "$_dst" && cp "$_src" "$_dst/daemon.tmp" && chmod 0755 "$_dst/daemon.tmp" &&
            mv -f "$_dst/daemon.tmp" "$_dst/daemon"; then
            log "installed $_name"
            pkill -f "^$_dst/daemon" 2>/dev/null
        else
            log "error: couldn't install $_name"
        fi
        chcon -R u:object_r:api_data_file:s0 "$_dst" 2>/dev/null
    done
    _dir=$(http_root)/flipfull
    [ -d "$_dir" ] || mkdir -p "$_dir" || return 1
    for _js in "$USERINIT"/remote/*.js; do
        [ -f "$_js" ] || continue
        _to=$_dir/${_js##*/}
        [ "$1" = missing ] && [ -f "$_to" ] && continue
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
