USERINIT=${FLIPFULL_HOME:-/data/local/userinit}
LOG_TAG=${LOG_TAG:-userinit}
BOOT_PLAN=$USERINIT/state/boot-plan

REGISTRY=$USERINIT/features.ini
PLAN_AWK=$USERINIT/lib/plan.awk
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

plan() { awk -f "$PLAN_AWK" -v choices="$CHOICES" "$REGISTRY"; }

needs() { awk -f "$PLAN_AWK" -v mode=needs "$REGISTRY"; }

# the names of one need kind in a plan
wanted() { echo "$2" | awk -v kind="$1" '$1 == kind { print $2 }'; }

# the names under DIR/ that setup changed
changed_in() { echo "$2" | sed -n "s|^$1/\([^/]*\)/.*|\1|p" | sort -u; }

# needs/KIND.sh is one need kind: KIND_status NAME says whether it works here and what a
# change takes (plan.awk's works()), KIND_apply WHEN PLAN [CHANGED] makes the phone match PLAN.
# WHEN is post-fs-data or boot-completed (the boot plan), set (flipfull set, and uninstall with
# no plan), setup (CHANGED: the files it changed) or uninstall (the boot that removes Flipfull)
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
    mkdir -p "$dir" "$STATE" || return 1
    { if [ -n "$1" ]; then echo "$1"; else plan; fi; } | awk '$1 == "feature" && $3 == "on" { print $2 }' \
        > "$STATE/features.tmp" && chmod 0644 "$STATE/features.tmp" && mv -f "$STATE/features.tmp" "$STATE/features" || return 1
    awk -v src="$USERINIT/flipfull" '
        BEGIN {
            print "// Written by " src ": the Flipfull features that are on."
            printf "window.FlipfullFeatures = {"
        }
        { printf "%s\"%s\": true", n++ ? ", " : "", $1 }
        END { print "};" }' "$STATE/features" > "$dir/features.js.tmp" &&
        chmod 0644 "$dir/features.js.tmp" && mv -f "$dir/features.js.tmp" "$dir/features.js"
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

same_file() { [ "$(stat -c %d:%i "$1" 2>/dev/null)" = "$(stat -c %d:%i "$2" 2>/dev/null)" ]; }

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
