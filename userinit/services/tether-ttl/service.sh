#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=tether-ttl

DIR=$USERINIT/services/tether-ttl
BIN=$DIR/ttlfix
QUEUE=0
TTL=64
IFACE="rmnet_data+"

rule() {
    case "$1" in
        iptables)  "$1" -w -t mangle "$2" POSTROUTING -o "$IFACE" -m ttl ! --ttl-eq "$TTL" \
                       -j NFQUEUE --queue-num "$QUEUE" --queue-bypass ;;
        ip6tables) "$1" -w -t mangle "$2" POSTROUTING -o "$IFACE" -m hl ! --hl-eq "$TTL" \
                       -j NFQUEUE --queue-num "$QUEUE" --queue-bypass ;;
    esac
}

stop() {
    for p in $(pids_of ttlfix); do
        kill "$p" 2>/dev/null
    done
    for t in iptables ip6tables; do
        while rule "$t" -D 2>/dev/null; do :; done
    done
}

status() {
    P=$(pids_of ttlfix)
    [ -n "$P" ] && log "helper running (pid $P)" || log "helper not running"
    iptables  -w -t mangle -L POSTROUTING -n -v 2>&1 | grep -E "Chain|NFQUEUE"
    ip6tables -w -t mangle -L POSTROUTING -n -v 2>&1 | grep -E "Chain|NFQUEUE"
}

start_helper() {
    setsid "$1" "$QUEUE" "$TTL" </dev/null >/dev/null 2>&1 &
    HPID=$!
    sleep 1
    kill -0 "$HPID" 2>/dev/null
}

start() {
    if [ ! -f "$BIN" ]; then
        log "helper $BIN not found - skipping"
        return 0
    fi
    chmod 0755 "$BIN" 2>/dev/null
    stop

    if start_helper "$BIN"; then
        log "helper running (pid $HPID)"
    else
        started=0
        for d in /dev /mnt /data/local/tmp; do
            alt="$d/.ttlfix"
            if cp "$BIN" "$alt" 2>/dev/null && chmod 0755 "$alt" 2>/dev/null && start_helper "$alt"; then
                log "helper running (pid $HPID) from $alt"
                started=1
                break
            fi
        done
        if [ "$started" != 1 ]; then
            log "could not start the helper; tethered traffic keeps its own TTL"
            return 1
        fi
    fi
    detach_cgroup ttlfix "$HPID"

    for t in iptables ip6tables; do
        if rule "$t" -C 2>/dev/null; then
            log "$t rule already present"
        elif rule "$t" -A; then
            log "$t rule added"
        else
            log "$t rule FAILED"
        fi
    done
}

case "$1" in
    start)   start ;;
    stop)    stop; log "stopped, rules removed" ;;
    restart) stop; start ;;
    status)  status ;;
    *)       echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
