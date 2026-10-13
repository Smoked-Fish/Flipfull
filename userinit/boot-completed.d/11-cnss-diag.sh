#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=disable-cnss-diag

if ! planned feature disable-cnss-diag on; then
    log "disable-cnss-diag is off - the wifi log will keep running"
    exit 0
fi

svc=vendor.cnss_diag
state=$(getprop "init.svc.$svc")
case "$state" in
    '') log "$svc: no such service" ;;
    stopped) log "$svc: already stopped" ;;
    *) stop "$svc" && log "$svc: stopped (was $state)" ;;
esac

exit 0
