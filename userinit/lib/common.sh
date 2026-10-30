USERINIT=${FLIPFULL_HOME:-/data/local/userinit}
LOG_TAG=${LOG_TAG:-userinit}
BOOT_PLAN=$USERINIT/state/boot-plan

REGISTRY=$USERINIT/features.ini
PLAN_AWK=$USERINIT/lib/plan.awk
SERVICES_INI=$USERINIT/remote/services.ini
CONFIG=$USERINIT/config
STATE=$USERINIT/state
CHOICES=$CONFIG/features
MANIFEST=$USERINIT/.installed-files
VROOT=/data/local/webapps/vroot
APPS_SOCK=/data/local/tmp/apps-uds.sock
APPS_DB=/data/local/webapps/db/apps.sqlite
SQLITE=$USERINIT/bin/sqlite3
API_DAEMON=/data/local/service/api-daemon

# Append
case ":$PATH:" in
    *":$USERINIT/bin/bbx:"*) ;;
    *) PATH=$PATH:$USERINIT/bin/bbx; export PATH ;;
esac

die() {
    echo "error: $*" >&2
    exit 1
}

log() { echo "${LOG_TAG:+[$LOG_TAG] }$*"; }

planned() { grep -qxF "$*" "$BOOT_PLAN" 2>/dev/null; }

plan() { awk -f "$PLAN_AWK" -v choices="$CHOICES" -v services="$SERVICES_INI" "$REGISTRY"; }

needs() { awk -f "$PLAN_AWK" -v mode=needs -v services="$SERVICES_INI" "$REGISTRY"; }

wanted() { echo "$2" | awk -v kind="$1" '$1 == kind { print $2 }'; }

changed_in() { echo "$2" | sed -n "s|^$1/\([^/]*\)/.*|\1|p" | sort -u; }

load_needs() {
    for f in "$USERINIT"/needs/*.sh; do
        [ -f "$f" ] && . "$f"
    done
}

needs_apply() {
    for f in "$USERINIT"/needs/*.sh; do
        [ -f "$f" ] || continue
        f=${f##*/}
        "${f%.sh}_apply" "$1" "$2" "$3"
    done
}

http_root() {
    r=$(sed -n '/^\[http\]/,/^\[/s/^root_path *= *"\(.*\)"/\1/p' "$API_DAEMON/config.toml" 2>/dev/null)
    echo "${r:-$API_DAEMON/http_root}"
}

# features.js tells the overlays which features are on, state/features tells the remote services
publish() {
    dir=$(http_root)/flipfull
    [ -d "$dir" ] && [ -d "$STATE" ] || mkdir -p "$dir" "$STATE" || return 1
    { if [ -n "$1" ]; then echo "$1"; else plan; fi; } | awk -v list="$STATE/features.tmp" -v js="$dir/features.js.tmp" \
        -v src="$USERINIT/flipfull" '
        $1 == "feature" && $3 == "on" { print $2 > list; on = on (n++ ? ", " : "") "\"" $2 "\": true" }
        END {
            printf "" > list
            print "// Written by " src ": the Flipfull features that are on." > js
            print "window.FlipfullFeatures = {" on "};" > js
        }' && chmod 0644 "$STATE/features.tmp" "$dir/features.js.tmp" &&
        mv -f "$STATE/features.tmp" "$STATE/features" && mv -f "$dir/features.js.tmp" "$dir/features.js"
}

apps_cmd() {
    if [ $# -gt 1 ]; then
        echo "{\"cmd\":\"$1\",\"param\":\"$2\"}"
    else
        echo "{\"cmd\":\"$1\"}"
    fi | nc -U -W 120 "$APPS_SOCK" 2>&1
}

apps_ok() { case $1 in *'"success"'*) return 0 ;; esac; return 1; }

json_value() {
    tr -d '\n' | awk -v want="$1" '
    {
        s = $0
        while (match(s, /"[^"]*" *: *"[^"]*"/)) {
            pair = substr(s, RSTART, RLENGTH)
            s = substr(s, RSTART + RLENGTH)
            split(pair, a, /"/)
            if (a[2] == want) { print a[4]; exit }
        }
    }'
}

detach_cgroup() {
    cg=/sys/fs/cgroup/userinit-$1
    mkdir -p "$cg" 2>/dev/null
    if echo "$2" > "$cg/cgroup.procs" 2>/dev/null; then
        log "pid $2 moved to $cg so init won't reap it"
    else
        log "WARNING: could not move pid $2 out of the userinit cgroup, init will kill it at the end of the stage"
    fi
}

pids_of() { pidof "$1" 2>/dev/null; }

# a file only Flipfull writes, bind-mounted over a phone file at boot
label_system_file() {
    chmod 0644 "$1" 2>/dev/null
    chown root:root "$1" 2>/dev/null
    chcon "${2:-u:object_r:system_file:s0}" "$1" 2>/dev/null
}

mounted_on() { grep -qs " $1 " /proc/mounts; }

same_file() { [ "$1" -ef "$2" ]; }

# init's stop and start return before the service has
svc_wait() {
    _i=0
    while [ "$(getprop "init.svc.$1")" != "$2" ] && [ $_i -lt 100 ]; do
        sleep 0.1
        _i=$((_i + 1))
    done
}

# runs "$@" while api-daemon is stopped; b2g reconnects to it on its own
api_daemon_restart() {
    stop api-daemon
    svc_wait api-daemon stopped
    "$@"
    start api-daemon
    svc_wait api-daemon running
    _i=0
    until echo '{"cmd":"list"}' | nc -U -W 5 "$APPS_SOCK" 2>/dev/null | grep -q '"success"' || [ $_i -ge 50 ]; do
        sleep 0.2
        _i=$((_i + 1))
    done
}

# whether a line of $1 matches the case pattern $2, without starting a grep, ugly
has_line() {
    case "
$1
" in *"
"$2"
"*) return 0 ;; esac
    return 1
}

has_word() {
    case " $1 " in *" $2 "*) return 0 ;; esac
    return 1
}
