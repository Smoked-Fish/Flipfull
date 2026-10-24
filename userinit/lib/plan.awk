function trim(s) {
    sub(/^[ \t]+/, "", s)
    sub(/[ \t\r]+$/, "", s)
    return s
}

function words(s, out) {
    s = trim(s)
    return s == "" ? 0 : split(s, out, /[ \t,]+/)
}

function chosen_on(id) {
    return (id in chosen) ? chosen[id] == "on" : val[id, "default"] == "on"
}

function requires(f, id,    k, req, j) {
    k = words(val[f, "requires"], req)
    for (j = 1; j <= k; j++)
        if (req[j] == id)
            return 1
    return 0
}

function resolve(    i, id, k, req, j, changed) {
    for (i = 1; i <= n; i++)
        on[ids[i]] = chosen_on(ids[i])
    do {
        changed = 0
        for (i = 1; i <= n; i++) {
            id = ids[i]
            if (!on[id])
                continue
            k = words(val[id, "requires"], req)
            for (j = 1; j <= k; j++)
                if (!on[req[j]]) {
                    on[id] = 0
                    changed = 1
                }
        }
    } while (changed)
}

function turn(id, v,    k, req, j, i, f) {
    chosen[id] = v
    if (v == "on") {
        k = words(val[id, "requires"], req)
        for (j = 1; j <= k; j++)
            if (!chosen_on(req[j])) {
                also[req[j]] = "on"
                turn(req[j], "on")
            }
    } else {
        for (i = 1; i <= n; i++) {
            f = ids[i]
            if (requires(f, id) && chosen_on(f)) {
                also[f] = "off"
                turn(f, "off")
            }
        }
    }
}

function needs(id, items,    c, kk, k, w, j) {
    c = 0
    for (kk = 1; kk <= NKINDS; kk++) {
        k = words(val[id, KEY[kk]], w)
        for (j = 1; j <= k; j++)
            items[++c] = KIND[kk] " " w[j]
    }
    return c
}

function read_choices(    line, eq) {
    if (choices == "")
        return
    while ((getline line < choices) > 0) {
        line = trim(line)
        if (line ~ /^[a-z0-9-]+=(on|off)$/) {
            eq = index(line, "=")
            chosen[substr(line, 1, eq - 1)] = substr(line, eq + 1)
        }
    }
    close(choices)
}

function make_plan(    i, id, c, items, j) {
    resolve()
    for (i = 1; i <= n; i++) {
        id = ids[i]
        planned["feature " id " " (on[id] ? "on" : "off")] = 1
        if (!on[id])
            continue
        c = needs(id, items)
        for (j = 1; j <= c; j++)
            planned[items[j]] = 1
    }
}

function print_plan(    i, id, c, items, j, seen) {
    for (i = 1; i <= n; i++)
        print "feature", ids[i], (on[ids[i]] ? "on" : "off")
    for (i = 1; i <= n; i++) {
        id = ids[i]
        if (!on[id])
            continue
        c = needs(id, items)
        for (j = 1; j <= c; j++)
            if (!seen[items[j]]++)
                print items[j]
    }
}

function works(r) {
    return r == "" || r == "ok" || r == "now" || r == "restart" || r == "reopen" || r == "boot"
}

function work_out_state(    line, w, i, id, c, items, j, b, changed, pend, bad, total, why, sp, r) {
    while ((getline line < boot) > 0) {
        split(line, w, " ")
        if (w[1] == "feature")
            at_boot[w[2]] = w[3]
        else
            booted[line] = 1
    }
    close(boot)
    while ((getline line < avail) > 0) {
        if (line ~ /^#/)
            continue
        split(line, w, " ")
        sp = index(line, w[2]) + length(w[2])
        usable[w[1] " " w[2]] = trim(substr(line, sp))
    }
    close(avail)

    reboot_any = pending
    for (i = 1; i <= n; i++) {
        id = ids[i]
        st_now[i] = on[id] ? "on" : "off"
        b = (id in at_boot) ? at_boot[id] : "-"
        c = needs(id, items)
        changed = (st_now[i] != (b == "-" ? "off" : b))
        pend = (changed && val[id, "reboot"] == "yes")
        total = bad = 0
        why = ""
        for (j = 1; j <= c; j++) {
            total++
            split(items[j], w, " ")
            r = usable[items[j]]
            if (r == "reboot") {
                if (on[id])
                    pend = 1
            } else if (!works(r)) {
                bad++
                if (why == "")
                    why = r
            } else if (changed && w[1] == "overlay") {
                if (r == "boot" || ((r == "restart" || r == "reopen") &&
                                    (items[j] in booted) && !(items[j] in planned)))
                    pend = 1
            } else if (changed && (w[1] == "hosts" || w[1] == "prefs") &&
                       ((items[j] in planned) != (items[j] in booted))) {
                pend = 1
            }
        }
        reboot_any = reboot_any || pend
        st_boot[i] = b
        st_pend[i] = pend
        st_usable[i] = bad == 0 ? "yes" : bad == total ? "no" : "partly"
        st_why[i] = why
    }
}

function print_state(    i) {
    print "reboot\t" (reboot_any ? "yes" : "no")
    for (i = 1; i <= n; i++)
        print "feature\t" ids[i] "\t" st_now[i] "\t" st_boot[i] "\t" (st_pend[i] ? "yes" : "no") "\t" \
              st_usable[i] "\t" st_why[i]
}

function print_list(    i, id, note) {
    for (i = 1; i <= n; i++) {
        id = ids[i]
        if (val[id, "section"] != "")
            print "\n" val[id, "section"]
        note = st_pend[i] ? "  (after a reboot)" : ""
        if (st_usable[i] != "yes")
            note = note "  - " (st_usable[i] == "no" ? "unusable" : "partly") ": " st_why[i]
        printf "  [%s] %-20s %s%s\n", (st_now[i] == "on" ? "x" : " "), id, val[id, "title"], note
    }
    if (reboot_any)
        print "\nSome changes wait for a reboot."
}

BEGIN {
    NKINDS = split("overlays hosts prefs services apps remote", KEY, " ")
    split("overlay hosts prefs service app remote", KIND, " ")
    if (mode == "")
        mode = "plan"
}

/^[ \t]*([#;]|$)/ { next }

/^\[/ {
    id = $0
    sub(/^\[/, "", id)
    sub(/\].*$/, "", id)
    ids[++n] = id
    known[id] = 1
    next
}

{
    eq = index($0, "=")
    if (eq && n)
        val[id, trim(substr($0, 1, eq - 1))] = trim(substr($0, eq + 1))
}

END {
    read_choices()
    if (mode == "needs") {
        for (i = 1; i <= n; i++) {
            c = needs(ids[i], items)
            for (j = 1; j <= c; j++)
                print ids[i], items[j]
        }
    } else if (mode == "choose") {
        k = words(changes, change)
        for (j = 1; j <= k; j++) {
            eq = index(change[j], "=")
            f = substr(change[j], 1, eq - 1)
            v = substr(change[j], eq + 1)
            if (!(f in known) || (v != "on" && v != "off")) {
                print "error " (f in known ? f ": say on or off" : "no feature called " f)
                exit 1
            }
            asked[f] = 1
            turn(f, v)
        }
        for (i = 1; i <= n; i++)
            if (ids[i] in chosen)
                print "choice", ids[i], chosen[ids[i]]
        for (i = 1; i <= n; i++)
            if ((ids[i] in also) && !(ids[i] in asked))
                print "also", ids[i], also[ids[i]]
    } else if (mode == "state" || mode == "list") {
        make_plan()
        work_out_state()
        if (mode == "state")
            print_state()
        else
            print_list()
    } else {
        resolve()
        print_plan()
    }
}
