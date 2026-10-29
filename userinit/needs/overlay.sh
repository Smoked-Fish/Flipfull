HTTP_CACHE=/data/cache/cache2

overlays_read() {
    PRELOADED=$("$SQLITE" -init /dev/null "$APPS_DB" 'SELECT name FROM apps WHERE preloaded = 1' 2>/dev/null)
    MOUNTS=$(cat /proc/mounts)
}

overlay_target() { readlink -f "$VROOT/$1" 2>/dev/null; }

overlay_is_app() { [ -n "$PRELOADED" ] && ! has_line "$PRELOADED" "$1"; }

stock_matches() {
    [ -f "$1/stock.md5" ] || return 0
    id=$(stat -c '%d:%i:%s:%Y' "$2" 2>/dev/null) || return 1
    sum=
    if [ -f "$STATE/stock-md5" ]; then
        while read -r f fid fsum; do
            [ "$f" = "$2" ] && [ "$fid" = "$id" ] && sum=$fsum
        done < "$STATE/stock-md5"
    fi
    if [ -z "$sum" ]; then
        sum=$(md5sum "$2" 2>/dev/null | cut -d' ' -f1)
        [ -n "$sum" ] || return 1
        mkdir -p "$STATE" && echo "$2 $id $sum" >> "$STATE/stock-md5"
    fi
    while read -r want; do
        [ "$want" = "$sum" ] && return 0
    done < "$1/stock.md5"
    return 1
}

# how an overlay applies (app, mounted, mount), or why it can't (status 1)
overlay_check() {
    _src=$USERINIT/overlays/$1
    if [ -e "$_src/disabled" ]; then
        echo "switched off on this phone (overlays/$1/disabled)"
        return 1
    fi
    if [ ! -f "$_src/application.zip" ]; then
        echo "not on the phone"
        return 1
    fi
    if overlay_is_app "$1"; then
        echo app
        return 0
    fi
    _dst=$(overlay_target "$1")
    if [ -z "$_dst" ] || [ ! -d "$_dst" ]; then
        echo "the phone has no $1 app"
        return 1
    fi
    if same_file "$_src" "$_dst"; then
        echo mounted
        return 0
    fi
    case $MOUNTS in
        *" $_dst "*)
            echo "something else is mounted over the phone's $1 app"
            return 1 ;;
    esac
    if stock_matches "$_src" "$_dst/application.zip"; then
        echo mount
        return 0
    fi
    echo "made for another version of the phone's $1 app"
    return 1
}

overlay_status() {
    [ -n "$MOUNTS" ] || overlays_read
    _how=$(overlay_check "$1") || { echo "$_how"; return 1; }
    case $_how in
        app) echo now ;;
        mount) echo reboot ;;
        # the build writes how a change to the overlay shows: reopen, restart or boot
        *) cat "$USERINIT/overlays/$1/shows" 2>/dev/null || echo reopen ;;
    esac
}

overlay_apply() {
    case $1 in
        post-fs-data) overlay_mount "$2" ;;
        set) overlay_apps "$2" ;;
        setup)
            overlay_label
            overlay_apps "$2" "$(changed_in overlays "$3")" ;;
    esac
}

overlay_mount() {
    overlays_read
    _planned=$(wanted overlay "$1")
    has_line "$_planned" system && _planned="system $_planned"
    _todo=
    _now=
    _seen=" "
    for _name in $_planned; do
        has_word "$_seen" "$_name" && continue
        _seen="$_seen$_name "
        _how=$(overlay_check "$_name")
        case $_how in
            mount)
                _src=$USERINIT/overlays/$_name
                _todo="$_todo$_name $_src $(overlay_target "$_name")
"
                _now="$_now$_name $(stat -c '%i %s %Y' "$_src/application.zip") " ;;
            mounted) log "overlay $_name: already mounted" ;;
            app) log "overlay $_name: not an app the phone came with, installed as an app instead" ;;
            *) log "overlay $_name: $_how - not mounted" ;;
        esac
    done
    if [ "$_now" != "$(cat "$STATE/overlays-mounted" 2>/dev/null)" ]; then
        rm -rf "$HTTP_CACHE"
        log "overlays changed since the last boot - cleared b2g's HTTP cache ($HTTP_CACHE)"
        echo "$_now" > "$STATE/overlays-mounted"
    fi
    echo "$_todo" | while read -r _name _src _dst; do
        [ -n "$_name" ] || continue
        if mount -o bind "$_src" "$_dst"; then
            log "overlay $_name: mounted over $_dst"
        else
            log "overlay $_name: mount failed - stock app in use"
        fi
    done
}

# the overlay dirs take the label of the app they go over
overlay_label() {
    for _src in "$USERINIT"/overlays/*; do
        _dst=$(overlay_target "${_src##*/}")
        [ -f "$_src/application.zip" ] && [ -n "$_dst" ] && [ -d "$_dst" ] || continue
        chmod 0755 "$_src" && chmod 0644 "$_src"/*
        _ctx=$(ls -Zd "$_dst" 2>/dev/null | awk '{ print $1 }')
        case $_ctx in u:object_r:*) chcon -R "$_ctx" "$_src" ;; esac
    done
}

# an overlay for an app the phone didn't come with is installed as an app, and removed when off
overlay_apps() {
    overlays_read
    _want=$(wanted overlay "$1")
    _list=
    for _src in "$USERINIT"/overlays/*; do
        _name=${_src##*/}
        [ -f "$_src/application.zip" ] && [ ! -e "$_src/disabled" ] && overlay_is_app "$_name" || continue
        [ -n "$_list" ] || _list=$(apps_cmd list)
        apps_ok "$_list" || return 0
        _installed=0
        has_line "$(installed_names "$_list")" "$_name" && _installed=1
        if has_line "$_want" "$_name"; then
            if [ $_installed = 0 ] || has_line "$2" "$_name"; then
                install_zip "$_src/application.zip" "$_name"
            fi
        elif [ $_installed = 1 ]; then
            app_uninstall "http://$_name.localhost/manifest.webmanifest" "$_name"
        fi
    done
}
