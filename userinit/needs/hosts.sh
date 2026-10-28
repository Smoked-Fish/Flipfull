HOSTS_AT=/system/etc/hosts

hosts_status() {
    if [ -f "$USERINIT/etc/hosts.d/$1.hosts" ]; then
        echo boot
    else
        echo "not on the phone"
        return 1
    fi
}

hosts_apply() {
    [ "$1" = post-fs-data ] || return 0
    _lists=$(wanted hosts "$2")
    if [ -z "$_lists" ]; then
        log "hosts: no feature blocks anything - stock hosts in use"
        return 0
    fi
    if mounted_on "$HOSTS_AT"; then
        log "hosts: $HOSTS_AT already has something mounted on it - skipping"
        return 0
    fi
    {
        cat "$USERINIT/etc/hosts.d/base.hosts"
        for _g in $_lists; do
            cat "$USERINIT/etc/hosts.d/$_g.hosts" || log "hosts: etc/hosts.d/$_g.hosts missing" >&2
        done
    } | awk 'NF && $1 !~ /^#/ { print }' | sort -u > "$STATE/hosts"
    label_system_file "$STATE/hosts"
    if mount -o bind "$STATE/hosts" "$HOSTS_AT"; then
        log "hosts: bind-mounted $STATE/hosts over $HOSTS_AT: base" $_lists
    else
        log "hosts: mount failed - stock hosts still in use"
    fi
}
