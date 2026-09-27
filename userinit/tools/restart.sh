#!/system/bin/sh

if [ $# -eq 0 ]; then
    stop b2g
    start b2g
    echo "b2g restarted"
    exit 0
fi

apps() {
    for p in /proc/[0-9]*; do
        case "$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)" in
            *b2g*" tab"*) cat "$p/comm" 2>/dev/null ;;
        esac
    done | sort -u | tr '\n' ' '
}

rc=0
for app in "$@"; do
    killed=""
    for p in /proc/[0-9]*; do
        [ "$(cat "$p/comm" 2>/dev/null)" = "$app" ] || continue
        kill "${p#/proc/}" 2>/dev/null && killed="$killed ${p#/proc/}"
    done
    if [ -n "$killed" ]; then
        echo "$app: killed$killed"
    else
        echo "$app: not running (running: $(apps))"
        rc=1
    fi
done
exit $rc
