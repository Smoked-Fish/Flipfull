#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=callrec

DIR=$USERINIT/services/callrec
BIN=$DIR/callrecd
DEX=$DIR/callrec.dex
LOG=$DIR/callrecd.log
LOG_MAX=262144
PORT=8322
ORIGIN=http://callscreen.localhost
WORK=/data/local/tmp/callrec

[ -f "$DIR/callrec.conf" ] && . "$DIR/callrec.conf"

recorders() {
    for p in /proc/[0-9]*; do
        case "$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)" in
            *" CallRec $WORK"*) echo "${p#/proc/}" ;;
        esac
    done
}

stop() {
    for p in $(pids_of callrecd) $(recorders); do
        kill "$p" 2>/dev/null
    done
    i=0
    while [ -n "$(pids_of callrecd)" ] && [ $i -lt 20 ]; do
        sleep 0.1
        i=$((i + 1))
    done
}

status() {
    P=$(pids_of callrecd)
    if [ -n "$P" ]; then
        log "running (pid $P) on 127.0.0.1:$PORT"
        R=$(recorders)
        [ -n "$R" ] && log "recording now (pid $R)"
        [ -f "$WORK/state" ] && log "last recording: $(cat "$WORK/state")"
    else
        log "not running"
    fi
}

start() {
    if [ ! -f "$BIN" ] || [ ! -f "$DEX" ]; then
        log "$BIN or $DEX not found - skipping"
        return 0
    fi
    chmod 0755 "$BIN" 2>/dev/null
    if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX" ]; then
        mv -f "$LOG" "$LOG.old"
    fi

    stop
    setsid "$BIN" --port "$PORT" --origin "$ORIGIN" --dir "$WORK" \
        --run "/system/bin/sh $USERINIT/tools/ap.sh $DEX CallRec" </dev/null >>"$LOG" 2>&1 &
    sleep 0.5

    P=$(pids_of callrecd)
    if [ -z "$P" ]; then
        log "failed to start - see $LOG"
        tail -3 "$LOG"
        return 1
    fi
    detach_cgroup callrecd "$P"
    log "running (pid $P) on 127.0.0.1:$PORT"
}

case "$1" in
    start)   start ;;
    stop)    stop; log "stopped" ;;
    restart) stop; start ;;
    status)  status ;;
    *)       echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
