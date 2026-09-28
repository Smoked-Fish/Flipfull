#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=toolbox

DIR=$USERINIT/services/toolbox
LOG=$DIR/httpd.log
PORT=8323

pid() { pgrep -f "httpd -f -p 127.0.0.1:$PORT " 2>/dev/null; }

stop() {
    for p in $(pid); do
        kill "$p" 2>/dev/null
    done
}

status() {
    P=$(pid)
    if [ -n "$P" ]; then
        log "running (pid $P) on 127.0.0.1:$PORT"
    else
        log "not running"
        return 1
    fi
}

start() {
    if [ -n "$(pid)" ]; then
        status
        return 0
    fi
    setsid "$USERINIT/bin/busybox" httpd -f -p "127.0.0.1:$PORT" -h "$DIR/www" </dev/null >>"$LOG" 2>&1 &
    sleep 0.3
    P=$(pid)
    if [ -z "$P" ]; then
        log "failed to start - see $LOG"
        return 1
    fi
    detach_cgroup toolbox "$P"
    log "running (pid $P) on 127.0.0.1:$PORT"
}

case "$1" in
    start)   start ;;
    stop)    stop; log "stopped" ;;
    restart) stop; sleep 0.3; start ;;
    status)  status ;;
    *)       echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
