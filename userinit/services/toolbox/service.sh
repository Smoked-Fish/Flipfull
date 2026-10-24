#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=toolbox

DIR=$USERINIT/services/toolbox
BIN=$DIR/toolboxd
LOG=$DIR/toolboxd.log
LOG_MAX=262144
SOCKET=$USERINIT/run/toolbox.sock

stop() {
    for p in $(pids_of toolboxd); do
        kill "$p" 2>/dev/null
    done
}

status() {
    P=$(pids_of toolboxd)
    if [ -n "$P" ]; then
        log "running (pid $P) on $SOCKET"
    else
        log "not running"
        return 1
    fi
}

start() {
    if [ -n "$(pids_of toolboxd)" ]; then
        status
        return 0
    fi
    mkdir -p "${SOCKET%/*}" && chmod 0711 "${SOCKET%/*}"
    chmod 0755 "$BIN" 2>/dev/null
    if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX" ]; then
        mv -f "$LOG" "$LOG.old"
    fi
    setsid "$BIN" --socket "$SOCKET" </dev/null >>"$LOG" 2>&1 &
    sleep 0.3
    P=$(pids_of toolboxd)
    if [ -z "$P" ]; then
        log "failed to start - see $LOG"
        return 1
    fi
    detach_cgroup toolbox "$P"
    log "running (pid $P) on $SOCKET"
}

case "$1" in
    start)   start ;;
    stop)    stop; log "stopped" ;;
    restart) stop; sleep 0.3; start ;;
    status)  status ;;
    *)       echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
