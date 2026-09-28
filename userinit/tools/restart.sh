#!/system/bin/sh

if [ $# -eq 0 ]; then
    stop b2g
    start b2g
    echo "b2g restarted"
    exit 0
fi

apps() {
    for f in $(grep -l 'true.ta[b]' /proc/[0-9]*/cmdline 2>/dev/null); do
        cat "${f%/cmdline}/comm"
    done 2>/dev/null | sort -u | tr '\n' ' '
}

rc=0
for app in "$@"; do
    pids=$(grep -lx "$app" /proc/[0-9]*/comm 2>/dev/null | cut -d/ -f3)
    if [ -n "$pids" ]; then
        kill $pids 2>/dev/null
        echo "$app: killed" $pids
    else
        echo "$app: not running (running: $(apps))"
        rc=1
    fi
done
exit $rc
