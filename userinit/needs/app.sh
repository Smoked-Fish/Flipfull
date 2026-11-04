APPS_ALWAYS=flipfull

app_url() {
    m=$USERINIT/apps/$1/manifest.webmanifest
    [ -f "$m" ] || return 1
    origin=$(json_value origin < "$m")
    [ -n "$origin" ] && echo "http://$origin.localhost/manifest.webmanifest"
}

install_zip() {
    tmp=/data/local/tmp/flipfull-$2.zip
    cp "$1" "$tmp" && chmod 0644 "$tmp" || return 1
    r=$(apps_cmd install "$tmp")
    rm -f "$tmp"
    if apps_ok "$r"; then
        echo "installed $2"
    else
        echo "error: $2 didn't install: $r"
        return 1
    fi
}

app_uninstall() {
    if apps_ok "$(apps_cmd uninstall "$1")"; then
        echo "uninstalled $2"
    else
        echo "error: $2 didn't uninstall"
    fi
}

installed_names() { echo "$1" | tr -d '\\' | grep -o '"name":"[^"]*"' | cut -d'"' -f4; }

app_status() {
    if [ -f "$USERINIT/apps/$1/application.zip" ]; then
        echo now
    else
        echo "not on the phone"
        return 1
    fi
}

app_apply() {
    case $1 in set|setup) ;; *) return 0 ;; esac
    _list=$(apps_cmd list)
    if ! apps_ok "$_list"; then
        echo "error: api-daemon's app list isn't available: $_list"
        return 1
    fi
    _force=$(changed_in apps "$3")
    for _d in "$USERINIT"/apps/*/; do
        _name=${_d%/}
        _name=${_name##*/}
        _url=$(app_url "$_name") || continue
        _installed=0
        case $_list in *"$_url"*) _installed=1 ;; esac
        if has_word "$APPS_ALWAYS" "$_name" || has_line "$2" "app $_name"; then
            if [ $_installed = 0 ] || has_line "$_force" "$_name"; then
                install_zip "$USERINIT/apps/$_name/application.zip" "$_name"
            fi
        elif [ $_installed = 1 ]; then
            app_uninstall "$_url" "$_name"
        fi
    done
}
