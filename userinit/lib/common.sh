USERINIT=${FLIPFULL_HOME:-/data/local/userinit}
LOG_TAG=${LOG_TAG:-userinit}
BOOT_PLAN=$USERINIT/state/boot-plan

REGISTRY=$USERINIT/features.ini
PLAN_AWK=$USERINIT/lib/plan.awk
CONFIG=$USERINIT/config
STATE=$USERINIT/state
CHOICES=$CONFIG/features
MANIFEST=$USERINIT/.installed-files
VROOT=/data/local/webapps/vroot
APPS_SOCK=/data/local/tmp/apps-uds.sock
APPS_DB=/data/local/webapps/db/apps.sqlite
SQLITE=$USERINIT/bin/sqlite3

die() {
    echo "error: $*" >&2
    exit 1
}

log() { echo "[$LOG_TAG] $*"; }

planned() { grep -qxF "$*" "$BOOT_PLAN" 2>/dev/null; }

plan() { awk -f "$PLAN_AWK" -v choices="$CHOICES" "$REGISTRY"; }

needs() { awk -f "$PLAN_AWK" -v mode=needs "$REGISTRY"; }

apps_cmd() {
    if [ $# -gt 1 ]; then
        echo "{\"cmd\":\"$1\",\"param\":\"$2\"}"
    else
        echo "{\"cmd\":\"$1\"}"
    fi | nc -U -W 120 "$APPS_SOCK" 2>&1
}

apps_ok() { case $1 in *'"success"'*) return 0 ;; esac; return 1; }

json_value() {
    tr -d '\n' | awk -v want="$1" '
    {
        s = $0
        while (match(s, /"[^"]*" *: *"[^"]*"/)) {
            pair = substr(s, RSTART, RLENGTH)
            s = substr(s, RSTART + RLENGTH)
            split(pair, a, /"/)
            if (a[2] == want) { print a[4]; exit }
        }
    }'
}

detach_cgroup() {
    cg=/sys/fs/cgroup/userinit-$1
    mkdir -p "$cg" 2>/dev/null
    if echo "$2" > "$cg/cgroup.procs" 2>/dev/null; then
        log "pid $2 moved to $cg so init won't reap it"
    else
        log "WARNING: could not move pid $2 out of the userinit cgroup - init will kill it at the end of the stage"
    fi
}

pids_of() { pidof "$1" 2>/dev/null; }

preloaded_apps() {
    "$USERINIT/bin/sqlite3" -init /dev/null /data/local/webapps/db/apps.sqlite \
        'SELECT name FROM apps WHERE preloaded = 1' 2>/dev/null
}

same_dir() { [ "$(stat -c %d:%i "$1" 2>/dev/null)" = "$(stat -c %d:%i "$2" 2>/dev/null)" ]; }

# build lookup table
stock_matches() {
    [ -f "$1/stock.md5" ] || return 0
    id=$(stat -c '%d:%i:%s:%Y' "$2" 2>/dev/null) || return 1
    key="$2 $id"

    if [ -z "${STOCK_MD5_MAP_BUILT:-}" ]; then

        STOCK_MD5_MAP_BUILT=1
        STOCK_MD5_MAP=""
        if [ -f "$USERINIT/state/stock-md5" ]; then
            STOCK_MD5_MAP=$(awk '{ print $1" "$2"\t"$3 }' "$USERINIT/state/stock-md5" 2>/dev/null)
        fi
    fi

    sum=
    if [ -n "$STOCK_MD5_MAP" ]; then
        sum=$(printf '%s\n' "$STOCK_MD5_MAP" | awk -F'\t' -v k="$key" '$1 == k { print $2; exit }')
    fi
    if [ -z "$sum" ]; then
        sum=$(md5sum "$2" 2>/dev/null | cut -d' ' -f1)
        [ -n "$sum" ] || return 1
        mkdir -p "$USERINIT/state" && echo "$2 $id $sum" >> "$USERINIT/state/stock-md5"
        STOCK_MD5_MAP="$STOCK_MD5_MAP
$key	$sum"
    fi
}