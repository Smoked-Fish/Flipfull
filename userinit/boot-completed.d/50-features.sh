#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=features
load_needs

needs_apply boot-completed "$(cat "$BOOT_PLAN" 2>/dev/null)"

sh "$USERINIT/flipfull" state >/dev/null 2>&1
exit 0
