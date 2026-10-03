#!/system/bin/sh

BASE=/data/local/userinit
LOG="$BASE/run.log"
LOG_MAX=262144
SCRIPT_TIMEOUT=20

STAGE="$1"

log() { echo "$*" >> "$LOG"; }

uptime_s() { cut -d' ' -f1 /proc/uptime; }

log_duration() {
    # $1 = script name, $2 = start uptime seconds
    _start=$2
    _end=$(uptime_s)
    _dur=$(awk -v a="$_start" -v b="$_end" 'BEGIN { printf "%.2f", b - a }')
    log "-- $1 took ${_dur}s"
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
    if [ -f "$BASE/config/removable-apps" ] && [ -f "$BASE/post-fs-data.d/02-removable-apps.sh" ]; then
        sh "$BASE/post-fs-data.d/02-removable-apps.sh" reset >> "$LOG" 2>&1
    fi
    if [ -f "$BASE/flipfull" ]; then
        sh "$BASE/flipfull" publish --remove >> "$LOG" 2>&1
    fi
    if [ -f "$BASE/post-fs-data.d/04-gecko-prefs.sh" ]; then
        sh "$BASE/post-fs-data.d/04-gecko-prefs.sh" remove >> "$LOG" 2>&1
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
    log "-- $BASE/disable exists, skipping all stages"
    exit 0
fi
if [ -e "$BASE/disable-$STAGE" ]; then
    log "-- $BASE/disable-$STAGE exists, skipping this stage"
    exit 0
fi

DIR="$BASE/${STAGE}.d"

if [ ! -d "$DIR" ]; then
    log "-- $DIR does not exist, nothing to run"
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

log "-- $(date +%T) ($(uptime_s)) stage=$STAGE done"
exit 0