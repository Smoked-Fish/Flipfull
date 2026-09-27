#!/system/bin/sh

INTERVAL=1
NAMES=""
while [ $# -gt 0 ]; do
    case "$1" in
        -i) INTERVAL=$2; shift 2 ;;
        -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) NAMES="$NAMES $1"; shift ;;
    esac
done
if [ -z "$NAMES" ]; then
    echo "usage: $0 [-i SECONDS] NAME...   (-h for more)" >&2
    exit 2
fi

pids_for() {
    found=""
    for d in /proc/[0-9]*; do
        read -r c 2>/dev/null < "$d/comm" || continue
        [ "$c" = "$1" ] && found="$found ${d#/proc/}"
    done
    if [ -z "$found" ]; then
        for p in $(pgrep -f -- "$1" 2>/dev/null); do
            [ "$p" = "$$" ] && continue
            case "$(tr '\0' ' ' 2>/dev/null < /proc/$p/cmdline)" in
                *mon.sh*|"") ;;
                *) found="$found $p" ;;
            esac
        done
    fi
    echo $found
}

ticks_of() {
    read -r line 2>/dev/null < "/proc/$1/stat" || return 1
    set -- ${line##*\) }
    [ "$1" = Z ] && return 1
    echo $(( ${12} + ${13} ))
}

rss_of() {
    while read -r k v u; do
        [ "$k" = "VmRSS:" ] && { echo "$v"; return; }
    done 2>/dev/null < "/proc/$1/status"
    echo 0
}

now_cs() {
    read -r up idle < /proc/uptime
    frac=${up#*.}
    echo $(( ${up%.*} * 100 + ${frac#0} ))
}

size() {
    if [ "$1" -lt 1024 ]; then
        echo "$1 kB"
    else
        echo "$(( $1 / 1024 )).$(( $1 % 1024 * 10 / 1024 )) MB"
    fi
}

last_cs=$(now_cs)
first=1
while true; do
    cs=$(now_cs)
    elapsed=$(( cs - last_cs ))
    [ "$elapsed" -gt 0 ] || elapsed=1
    ts=$(date +%T)
    for name in $NAMES; do
        pids=$(pids_for "$name")
        if [ -z "$pids" ]; then
            echo "$ts  $name: not running"
            continue
        fi
        for p in $pids; do
            t=$(ticks_of "$p") || continue
            eval "prev=\${prev_$p:-}"
            eval "prev_$p=$t"
            if [ -z "$prev" ] || [ "$first" = 1 ]; then
                cpu="  -"
            else
                cpu="$(( (t - prev) * 100 / elapsed ))%"
            fi
            printf '%s  %-12s %6s  RSS %10s  CPU %5s\n' "$ts" "$name" "$p" "$(size "$(rss_of "$p")")" "$cpu"
        done
    done
    last_cs=$cs
    first=0
    sleep "$INTERVAL"
done
