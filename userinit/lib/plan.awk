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
    k = words(remote_of[id], w)
    for (j = 1; j <= k; j++)
        items[++c] = "remote " w[j]
    return c
}

function read_services(    line, name, eq, k, pair, j, w) {
    if (services == "")
        return
    while ((getline line < services) > 0) {
        line = trim(line)
        if (line ~ /^\[/) {
            name = substr(line, 2, index(line, "]") - 2)
        } else if (line ~ /^admits *=/) {
            eq = index(line, "=")
            k = split(substr(line, eq + 1), pair, ",")
            for (j = 1; j <= k; j++)
                if (words(pair[j], w) == 2 && w[2] != "always")
                    remote_of[w[2]] = remote_of[w[2]] " " name
        }
    }
    close(services)
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
    return r == "" || r == "now" || r == "restart" || r == "reopen" || r == "ui"
}

function read_avail(    line, w, sp) {
    while ((getline line < avail) > 0) {
        if (line ~ /^#/)
            continue
        split(line, w, " ")
        sp = index(line, w[2]) + length(w[2])
        usable[w[1] " " w[2]] = trim(substr(line, sp))
    }
    close(avail)
}

function work_out_state(    line, w, i, id, c, items, j, b, changed, pend, bad, total, why, r) {
    while ((getline line < boot) > 0) {
        split(line, w, " ")
        if (w[1] == "feature")
            at_boot[w[2]] = w[3]
    }
    close(boot)
    read_avail()

    ui_any = pending
    for (i = 1; i <= n; i++) {
        id = ids[i]
        st_now[i] = on[id] ? "on" : "off"
        b = (id in at_boot) ? at_boot[id] : "-"
        c = needs(id, items)
        changed = (st_now[i] != (b == "-" ? "off" : b))
        pend = 0
        total = bad = 0
        why = ""
        for (j = 1; j <= c; j++) {
            total++
            r = usable[items[j]]
            if (r == "later") {
                if (on[id])
                    pend = 1
            } else if (!works(r)) {
                bad++
                if (why == "")
                    why = r
            } else if (changed && r == "ui") {
                pend = 1
            }
        }
        ui_any = ui_any || pend
        st_boot[i] = b
        st_pend[i] = pend
        st_usable[i] = bad == 0 ? "yes" : bad == total ? "no" : "partly"
        st_why[i] = why
    }
}

function print_state(    i, k, h, sp) {
    k = split(head, h, "|")
    for (i = 1; i <= k; i++) {
        sp = index(h[i], " ")
        print substr(h[i], 1, sp - 1) "\t" substr(h[i], sp + 1)
    }
    print "removable\t" (pending ? "pending" : "saved")
    print "ui\t" (ui_any ? "yes" : "no")
    for (i = 1; i <= n; i++)
        print "feature\t" ids[i] "\t" st_now[i] "\t" st_boot[i] "\t" (st_pend[i] ? "yes" : "no") "\t" \
              st_usable[i] "\t" st_why[i]
}

function print_list(    i, id, note) {
    for (i = 1; i <= n; i++) {
        id = ids[i]
        if (val[id, "section"] != "")
            print "\n" val[id, "section"]
        note = st_pend[i] ? "  (after a UI restart)" : ""
        if (st_usable[i] != "yes")
            note = note "  - " (st_usable[i] == "no" ? "unusable" : "partly") ": " st_why[i]
        printf "  [%s] %-20s %s%s\n", (st_now[i] == "on" ? "x" : " "), id, val[id, "title"], note
    }
    if (ui_any)
        print "\nSome changes wait for the phone's UI to restart (flipfull restart)."
}

function print_restarts(    k, lines, w, j, c, items, m, seen) {
    read_avail()
    k = split(ENVIRON["PLAN_DIFF"], lines, "\n")
    for (j = 1; j <= k; j++) {
        if (split(lines[j], w, " ") != 3 || w[1] != "feature" || seen[w[2]]++)
            continue
        c = needs(w[2], items)
        for (m = 1; m <= c; m++)
            if (usable[items[m]] == "restart" && !seen[items[m]]++)
                print substr(items[m], index(items[m], " ") + 1)
    }
}

BEGIN {
    NKINDS = split("overlays hosts prefs autoconfig services apps steps", KEY, " ")
    split("overlay hosts prefs autoconfig service app step", KIND, " ")
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
    read_services()
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
    } else if (mode == "restarts") {
        print_restarts()
    } else if (mode == "state" || mode == "list") {
        resolve()
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
