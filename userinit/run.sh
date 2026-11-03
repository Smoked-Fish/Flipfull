#!/system/bin/sh

BASE=/data/local/userinit
LOG="$BASE/run.log"
LOG_MAX=262144
SCRIPT_TIMEOUT=20

# num of failed boots before flipfull is disabled automatically
COUNT="$BASE/bootcount"
CRASHLOOP="$BASE/disabled-by-crashloop"
CRASHLOOP_AT=2

# * and # held at boot, nothing runs
SAFE_MODE=/dev/.userinit-safe-mode
SAFE_MODE_KEYS="522 523"

STAGE="$1"

log() { echo "$*" >> "$LOG"; }

count_write() {
    echo "$1" > "$COUNT.tmp" && mv -f "$COUNT.tmp" "$COUNT"
    sync
}

count_clear() {
    [ -e "$COUNT" ] || [ -e "$COUNT.tmp" ] || return 0
    rm -f "$COUNT" "$COUNT.tmp"
    sync
}

uptime_s() { read -r _up _ < /proc/uptime; echo "$_up"; }

log_duration() {
    # $1 = script name, $2 = start uptime seconds
    _end=$(uptime_s)
    _s=$((${_end%.*} - ${2%.*}))
    _c=$((1${_end#*.} - 1${2#*.}))
    if [ "$_c" -lt 0 ]; then
        _c=$((_c + 100))
        _s=$((_s - 1))
    fi
    [ "$_c" -lt 10 ] && _c=0$_c
    log "-- $1 took ${_s}.${_c}s"
}

if [ -f "$LOG" ]; then
    SIZE=$(stat -c %s "$LOG" 2>/dev/null)
    case "$SIZE" in
        ''|*[!0-9]*) SIZE=0 ;;
    esac
    if [ "$SIZE" -gt "$LOG_MAX" ]; then
        mv -f "$LOG" "$LOG.old" 2>/dev/null
    fi
fi

log "==== $(date) : stage=${STAGE:-<none>} ===="

if [ -z "$STAGE" ]; then
    log "-- no stage argument given, nothing to do"
    exit 1
fi

if [ "$STAGE" = post-fs-data ] && [ -e "$BASE/uninstall" ]; then
    if [ -f "$BASE/post-fs-data.d/02-removable-apps.sh" ]; then
        sh "$BASE/post-fs-data.d/02-removable-apps.sh" reset >> "$LOG" 2>&1
    fi
    if [ -f "$BASE/post-fs-data.d/03-features.sh" ]; then
        sh "$BASE/post-fs-data.d/03-features.sh" uninstall >> "$LOG" 2>&1
    fi
    log "-- uninstall requested: removing everything in $BASE except run.sh"
    for f in "$BASE"/* "$BASE"/.[!.]*; do
        case "${f##*/}" in
            run.sh|run.log|run.log.old|'*'|'.[!.]*') ;;
            *) rm -rf "$f" ;;
        esac
    done
    rm -rf /data/cache/cache2
    log "-- uninstalled; the boot hook stays and runs nothing until reinstalled"
    exit 0
fi

if [ -e "$BASE/disable" ]; then
    if [ -e "$CRASHLOOP" ]; then
        log "-- $BASE/disable exists (crash-loop protection: $(cat "$CRASHLOOP")), skipping all stages"
    else
        log "-- $BASE/disable exists, skipping all stages"
    fi
    exit 0
fi

rm -f "$CRASHLOOP"

if [ "$STAGE" = post-fs-data ] && "$BASE/bin/keystate" $SAFE_MODE_KEYS 2>/dev/null; then
    touch "$SAFE_MODE"
    log "-- * and # held: safe mode, skipping all stages this boot"
    exit 0
fi
if [ -e "$SAFE_MODE" ]; then
    log "-- safe mode, skipping this stage"
    exit 0
fi

if [ "$STAGE" = post-fs-data ]; then
    N=0
    if [ -e "$COUNT" ]; then
        read -r N < "$COUNT"
        case "$N" in
            [0-9]|[1-9][0-9]) ;;
            # only a crash mid-write leaves this, so count it as a failed boot
            *)
                log "-- $COUNT holds '$N', not a number: counting it as 1 failed boot"
                N=1 ;;
        esac
    fi
    if [ "$N" -ge "$CRASHLOOP_AT" ]; then
        echo "$(date) after $N boots in a row that didn't finish" > "$CRASHLOOP"
        touch "$BASE/disable"
        count_clear
        log "-- CRASH LOOP: the last $N boots didn't finish (boot-completed never ran to the end)"
        log "-- created $BASE/disable, skipping all stages until it is deleted (flip4.py resume)"
        exit 0
    fi
    count_write $((N + 1))
fi

if [ -e "$BASE/disable-$STAGE" ]; then
    log "-- $BASE/disable-$STAGE exists, skipping this stage"
    [ "$STAGE" = boot-completed ] && count_clear
    exit 0
fi

DIR="$BASE/${STAGE}.d"

if [ ! -d "$DIR" ]; then
    log "-- $DIR does not exist, nothing to run"
    [ "$STAGE" = boot-completed ] && count_clear
    exit 0
fi

if command -v timeout >/dev/null 2>&1; then
    HAVE_TIMEOUT=1
else
    HAVE_TIMEOUT=0
    log "-- 'timeout' not found, scripts run with no time limit"
fi

for f in "$DIR"/*.sh; do
    [ -e "$f" ] || continue
    _t0=$(uptime_s)
    log "-- $(date +%T) ($_t0) running $f"

    if [ "$HAVE_TIMEOUT" = 1 ]; then
        timeout "$SCRIPT_TIMEOUT" sh "$f" < /dev/null >> "$LOG" 2>&1
    else
        sh "$f" < /dev/null >> "$LOG" 2>&1
    fi
    RC=$?

    if [ "$HAVE_TIMEOUT" = 1 ] && [ "$RC" -eq 124 ]; then
        log "-- $f TIMED OUT after ${SCRIPT_TIMEOUT}s (killed)"
    else
        log "-- $f exited $RC"
    fi

    log_duration "$f" "$_t0"
done

[ "$STAGE" = boot-completed ] && count_clear
log "-- $(date +%T) ($(uptime_s)) stage=$STAGE done"
exit 0