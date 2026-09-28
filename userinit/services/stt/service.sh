#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=stt

DIR=$USERINIT/services/stt
BIN=$DIR/stt-server
LOG=$DIR/server.log
LOG_MAX=262144
MODELS=$DIR/models
MODEL=parakeet-tdt_ctc-110m-Q4_K_M.gguf
CHOICE=$USERINIT/config/stt-model
THREADS=4
IDLE=15
PORT=8321
ORIGIN=http://kaios-voiceassistant.localhost
RUN_UID=9999

[ -f "$DIR/stt.conf" ] && . "$DIR/stt.conf"

stop() {
    for p in $(pids_of stt-server); do
        kill "$p" 2>/dev/null
    done
    i=0
    while [ -n "$(pids_of stt-server)" ] && [ $i -lt 20 ]; do
        sleep 0.1
        i=$((i + 1))
    done
}

status() {
    P=$(pids_of stt-server)
    if [ -n "$P" ]; then
        log "running (pid $P)"
        if command -v curl >/dev/null 2>&1; then
            curl -s "http://127.0.0.1:$PORT/health"; echo
        fi
    else
        log "not running"
        return 1
    fi
    return 0
}

start() {
    if [ ! -f "$BIN" ]; then
        log "binary $BIN not found - skipping"
        return 0
    fi
    if ! ls "$MODELS" 2>/dev/null | grep -qE '\.(gguf|bin)$'; then
        log "no models in $MODELS - skipping"
        return 0
    fi

    chmod 0711 "$USERINIT" "$USERINIT/services" "$DIR" "$MODELS" 2>/dev/null
    chmod 0644 "$MODELS"/* 2>/dev/null
    chmod 0755 "$BIN" 2>/dev/null
    mkdir -p "$(dirname "$CHOICE")"

    if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX" ]; then
        mv -f "$LOG" "$LOG.old"
    fi

    stop
    setsid "$BIN" --models "$MODELS" --model "$MODEL" --choice "$CHOICE" --threads "$THREADS" \
        --idle "$IDLE" --port "$PORT" --origin "$ORIGIN" --uid "$RUN_UID" </dev/null >>"$LOG" 2>&1 &
    sleep 1

    P=$(pids_of stt-server)
    if [ -z "$P" ]; then
        log "failed to start - see $LOG"
        tail -3 "$LOG"
        return 1
    fi
    detach_cgroup stt-server "$P"
    picked=$([ -s "$CHOICE" ] && cat "$CHOICE")
    log "running (pid $P) on 127.0.0.1:$PORT, model ${picked:-$MODEL}"
}

case "$1" in
    start)   start ;;
    stop)    stop; log "stopped" ;;
    restart) stop; start ;;
    status)  status ;;
    *)       echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
