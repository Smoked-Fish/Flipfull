USERINIT=${FLIPFULL_HOME:-/data/local/userinit}
LOG_TAG=${LOG_TAG:-userinit}
BOOT_PLAN=$USERINIT/state/boot-plan

log() { echo "[$LOG_TAG] $*"; }

planned() { grep -qxF "$*" "$BOOT_PLAN" 2>/dev/null; }

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

stock_matches() {
    [ -f "$1/stock.md5" ] || return 0
    id=$(stat -c '%d:%i:%s:%Y' "$2" 2>/dev/null) || return 1
    sum=
    if [ -f "$USERINIT/state/stock-md5" ]; then
        while read -r f fid fsum; do
            [ "$f" = "$2" ] && [ "$fid" = "$id" ] && sum=$fsum
        done < "$USERINIT/state/stock-md5"
    fi
    if [ -z "$sum" ]; then
        sum=$(md5sum "$2" 2>/dev/null | cut -d' ' -f1)
        [ -n "$sum" ] || return 1
        mkdir -p "$USERINIT/state" && echo "$2 $id $sum" >> "$USERINIT/state/stock-md5"
    fi
    while read -r want; do
        [ "$want" = "$sum" ] && return 0
    done < "$1/stock.md5"
    return 1
}
