HOSTS_AT=/system/etc/hosts

hosts_status() {
    if [ -f "$USERINIT/etc/hosts.d/$1.hosts" ]; then
        echo now
    else
        echo "not on the phone"
        return 1
    fi
}

hosts_apply() {
    case $1 in ui-start|ui|set) ;; *) return 0 ;; esac
    _lists=$(wanted hosts "$2")
    _ours=0
    same_file "$STATE/hosts" "$HOSTS_AT" && _ours=1
    if [ -z "$_lists" ]; then
        if [ $_ours = 1 ]; then
            umount "$HOSTS_AT" 2>/dev/null || umount -l "$HOSTS_AT"
        fi
        log "hosts: no feature blocks anything - stock hosts in use"
        return 0
    fi
    if [ $_ours = 0 ] && mounted_on "$HOSTS_AT"; then
        log "hosts: $HOSTS_AT already has something mounted on it - skipping"
        return 0
    fi
    {
        cat "$USERINIT/etc/hosts.d/base.hosts"
        for _g in $_lists; do
            cat "$USERINIT/etc/hosts.d/$_g.hosts" || log "hosts: etc/hosts.d/$_g.hosts missing" >&2
        done
    } | awk 'NF && $1 !~ /^#/ { print }' | sort -u > "$STATE/hosts.tmp"
    if [ $_ours = 1 ]; then
        cat "$STATE/hosts.tmp" > "$STATE/hosts"
        rm -f "$STATE/hosts.tmp"
        log "hosts: now base" $_lists
        return 0
    fi
    mv -f "$STATE/hosts.tmp" "$STATE/hosts"
    label_system_file "$STATE/hosts"
    if mount -o bind "$STATE/hosts" "$HOSTS_AT"; then
        log "hosts: bind-mounted $STATE/hosts over $HOSTS_AT: base" $_lists
    else
        log "hosts: mount failed - stock hosts still in use"
    fi
}
