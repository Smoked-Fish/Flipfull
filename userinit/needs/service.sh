SERVICES_ALWAYS=toolbox

service_status() {
    if [ ! -f "$USERINIT/services/$1/service.sh" ]; then
        echo "not on the phone"
        return 1
    fi
    if [ -e "$USERINIT/services/$1/disabled" ]; then
        echo "switched off on this phone (services/$1/disabled)"
        return 1
    fi
    echo now
}

service_running() { sh "$USERINIT/services/$1/service.sh" status >/dev/null 2>&1; }

service_apply() {
    case $1 in boot-completed|set|setup) ;; *) return 0 ;; esac
    _restart=$(changed_in services "$3")
    for _s in "$USERINIT"/services/*/service.sh; do
        [ -f "$_s" ] || continue
        _name=${_s%/service.sh}
        _name=${_name##*/}
        _want=0
        if has_word "$SERVICES_ALWAYS" "$_name" || has_line "$2" "service $_name"; then
            _want=1
        fi
        [ -e "${_s%/*}/disabled" ] && _want=0
        if service_running "$_name"; then
            if [ $_want = 0 ]; then
                sh "$_s" stop >/dev/null 2>&1
                log "stopped $_name"
            elif has_line "$_restart" "$_name"; then
                sh "$_s" restart >/dev/null 2>&1 && log "restarted $_name" || log "error: $_name didn't start again"
            fi
        elif [ $_want = 1 ] && [ "$1" = boot-completed ]; then
            sh "$_s" start || log "$_name: start failed"
        elif [ $_want = 1 ]; then
            sh "$_s" start >/dev/null 2>&1 && log "started $_name" || log "error: $_name didn't start (services/$_name)"
        fi
    done
}
