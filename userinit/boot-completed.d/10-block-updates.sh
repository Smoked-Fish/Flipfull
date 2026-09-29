#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=block-updates

if ! planned feature block-updates on; then
    log "block-updates is off - the updaters keep running"
    exit 0
fi

# updater-daemon required for dependency checks
for svc in update_engine; do
    state=$(getprop "init.svc.$svc")
    case "$state" in
        '') log "$svc: no such service" ;;
        stopped) log "$svc: already stopped" ;;
        *) stop "$svc" && log "$svc: stopped (was $state)" ;;
    esac
done
exit 0