APPS_ALWAYS=flipfull
DICTATE=http://dictate.localhost/manifest.webmanifest

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

app_install() {
    if [ "$1" = kaiva ]; then
        case $2 in *"$DICTATE"*)
            apps_ok "$(apps_cmd uninstall "$DICTATE")" && echo "uninstalled Dictate; KaiVA replaces it"
            case $2 in *"$3"*) apps_cmd uninstall "$3" >/dev/null ;; esac ;;
        esac
    fi
    install_zip "$USERINIT/apps/$1/application.zip" "$1"
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
        _name=$(basename "$_d")
        _url=$(app_url "$_name") || continue
        _installed=0
        case $_list in *"$_url"*) _installed=1 ;; esac
        if has_word "$APPS_ALWAYS" "$_name" || has_line "$2" "app $_name"; then
            if [ $_installed = 0 ] || has_line "$_force" "$_name"; then
                app_install "$_name" "$_list" "$_url"
            fi
        elif [ $_installed = 1 ]; then
            app_uninstall "$_url" "$_name"
        fi
    done
}
