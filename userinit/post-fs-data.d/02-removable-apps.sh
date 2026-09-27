#!/system/bin/sh

. /data/local/userinit/lib/common.sh
LOG_TAG=removable-apps

DB=/data/local/webapps/db/apps.sqlite
LIST="$USERINIT/removable-apps"
SQLITE="$USERINIT/bin/sqlite3"

if [ ! -f "$DB" ]; then
    log "$DB not found - nothing to do"
    exit 0
fi
if [ ! -x "$SQLITE" ]; then
    log "$SQLITE missing - can't edit $DB"
    exit 0
fi

if [ "$1" = reset ]; then
    IN=""
elif [ -f "$LIST" ]; then
    IN=$(grep -E '^[A-Za-z0-9._-]+$' "$LIST" | sed "s/.*/'&'/" | tr '\n' ',' | sed 's/,$//')
else
    exit 0
fi

SQL="UPDATE apps SET removable = CASE WHEN name IN (${IN:-''}) THEN 1 ELSE 0 END WHERE preloaded = 1;"
if OUT=$("$SQLITE" -init /dev/null "$DB" "$SQL" "SELECT count(*) FROM apps WHERE preloaded = 1 AND removable = 1;" 2>&1); then
    log "$OUT preloaded apps removable"
else
    log "database update failed: $OUT"
fi
[ "$1" = reset ] && rm -f "$LIST"
exit 0
