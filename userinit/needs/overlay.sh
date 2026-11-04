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

overlay_check() {
    _csrc=$USERINIT/overlays/$1
    if [ -e "$_csrc/disabled" ]; then
        HOW="switched off on this phone (overlays/$1/disabled)"
        return 1
    fi
    if [ ! -f "$_csrc/application.zip" ]; then
        HOW="not on the phone"
        return 1
    fi
    if overlay_is_app "$1"; then
        HOW=app
        return 0
    fi
    # sh's -ef doesn't follow the vroot link
    _cdst=$(overlay_target "$1")
    if [ -z "$_cdst" ] || [ ! -d "$_cdst" ]; then
        HOW="the phone has no $1 app"
        return 1
    fi
    if same_file "$_csrc" "$_cdst"; then
        HOW=mounted
        return 0
    fi
    case $MOUNTS in
        *" $_cdst "*)
            HOW="something else is mounted over the phone's $1 app"
            return 1 ;;
    esac
    if stock_matches "$_csrc" "$_cdst/application.zip"; then
        HOW=mount
        return 0
    fi
    HOW="made for another version of the phone's $1 app"
    return 1
}

overlay_live() { case $1 in system|shared) return 1 ;; esac; }

overlay_status() {
    [ -n "$MOUNTS" ] || overlays_read
    overlay_check "$1" || { echo "$HOW"; return 1; }
    _shows=reopen
    # the build writes how a change to the overlay shows: reopen, restart or ui
    [ -f "$USERINIT/overlays/$1/shows" ] && read -r _shows < "$USERINIT/overlays/$1/shows"
    case $HOW in
        app) echo now ;;
        mount) overlay_live "$1" && echo "$_shows" || echo later ;;
        *) echo "$_shows" ;;
    esac
}

overlay_apply() {
    case $1 in
        post-fs-data) overlay_mount "$2" ;;
        ui) overlay_mount "$2" ui ;;
        set)
            overlay_apps "$2"
            overlay_set "$2" ;;
        setup)
            overlay_label
            overlay_apps "$2" "$(changed_in overlays "$3")" ;;
    esac
}

overlay_set() {
    overlays_read
    _want=$(wanted overlay "$1")
    for _src in "$USERINIT"/overlays/*; do
        _name=${_src##*/}
        overlay_live "$_name" && [ -f "$_src/application.zip" ] && ! overlay_is_app "$_name" || continue
        _dst=$(overlay_target "$_name")
        [ -n "$_dst" ] || continue
        if has_line "$_want" "$_name"; then
            same_file "$_src" "$_dst" && continue
            overlay_check "$_name" && [ "$HOW" = mount ] || continue
            mount -o bind "$_src" "$_dst" || { echo "error: couldn't mount the $_name overlay"; continue; }
        elif same_file "$_src" "$_dst"; then
            umount "$_dst" 2>/dev/null || umount -l "$_dst" || continue
        else
            continue
        fi
        sh "$USERINIT/tools/restart.sh" "$_name" >/dev/null && echo "restarted $_name"
        RESTARTED="$RESTARTED $_name"
    done
}

overlay_mount() {
    overlays_read
    _planned=$(wanted overlay "$1")
    if [ "$2" = ui ]; then
        for _src in "$USERINIT"/overlays/*; do
            _name=${_src##*/}
            has_line "$_planned" "$_name" && continue
            _dst=$(overlay_target "$_name")
            [ -n "$_dst" ] && same_file "$_src" "$_dst" || continue
            umount "$_dst" && log "overlay $_name: unmounted, the stock app is back"
        done
    fi
    has_line "$_planned" system && _planned="system $_planned"
    _todo=
    _now=
    _seen=" "
    for _name in $_planned; do
        has_word "$_seen" "$_name" && continue
        _seen="$_seen$_name "
        overlay_check "$_name"
        _src=$USERINIT/overlays/$_name
        case $HOW in
            mount)
                _todo="$_todo$_name $_src $(overlay_target "$_name")
"
                _now="$_now$_name $(stat -c '%i %s %Y' "$_src/application.zip") " ;;
            mounted)
                _now="$_now$_name $(stat -c '%i %s %Y' "$_src/application.zip") "
                log "overlay $_name: already mounted" ;;
            app) log "overlay $_name: not an app the phone came with, installed as an app instead" ;;
            *) log "overlay $_name: $HOW - not mounted" ;;
        esac
    done
    _now="$_now| $(tr '\n' ' ' < "$STATE/features" 2>/dev/null)"
    if [ "$_now" != "$(cat "$STATE/overlays-mounted" 2>/dev/null)" ]; then
        rm -rf "$HTTP_CACHE"
        log "overlays or features changed since the last boot - cleared b2g's HTTP cache ($HTTP_CACHE)"
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
