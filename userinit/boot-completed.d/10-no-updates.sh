#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=no-updates

for svc in update_engine updater-daemon; do
    state=$(getprop "init.svc.$svc")
    case "$state" in
        '') log "$svc: no such service" ;;
        stopped) log "$svc: already stopped" ;;
        *) stop "$svc" && log "$svc: stopped (was $state)" ;;
    esac
done
exit 0
