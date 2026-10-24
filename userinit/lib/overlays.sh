OVERLAYS_AT_BOOT="system"
OVERLAYS_RESTART="launcher settings video"

overlays_read() {
    PRELOADED=$(preloaded_apps)
    MOUNTS=$(cat /proc/mounts)
}

overlay_target() { readlink -f "$VROOT/$1" 2>/dev/null; }

overlay_is_app() { [ -n "$PRELOADED" ] && ! has_line "$PRELOADED" "$1"; }

overlay_mounted() { same_dir "$USERINIT/overlays/$1" "$(overlay_target "$1")"; }

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
    if same_dir "$_src" "$_dst"; then
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
