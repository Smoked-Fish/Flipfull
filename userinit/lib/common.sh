USERINIT=/data/local/userinit
LOG_TAG=${LOG_TAG:-userinit}

log() { echo "[$LOG_TAG] $*"; }

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
