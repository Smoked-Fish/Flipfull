#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=services

for S in "$USERINIT"/services/*/service.sh; do
    [ -f "$S" ] || continue
    D=${S%/service.sh}
    NAME=${D##*/}
    if [ "$NAME" != toolbox ] && ! planned service "$NAME"; then
        log "$NAME: no feature that's on needs it"
        continue
    fi
    if [ -e "$D/disabled" ]; then
        log "$NAME: disabled"
        continue
    fi
    sh "$S" start || log "$NAME: start failed"
done
exit 0
