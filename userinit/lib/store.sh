STORE_REPO=Smoked-Fish/Flipstore
STORE_ORIGIN=flipstore
STORE_DIR=/data/local/tmp/flipstore
STORE_MAX=52428800
STORE_RECORDS=$CONFIG/flipstore-apps

app_url() {
    m=$USERINIT/apps/$1/manifest.webmanifest
    [ -f "$m" ] || return 1
    origin=$(json_value origin < "$m")
    [ -n "$origin" ] && echo "http://$origin.localhost/manifest.webmanifest"
}

install_zip() {
    tmp=/data/local/tmp/flipfull-$2.zip
    cp "$1" "$tmp" && chmod 0644 "$tmp" || return 1
    r=$(apps_cmd install "$tmp")
    rm -f "$tmp"
    if apps_ok "$r"; then
        echo "installed $2"
    else
        echo "error: $2 didn't install: $r"
        return 1
    fi
}

app_manifest() {
    m=$VROOT/$1/manifest.webmanifest
    if [ -f "$m" ]; then
        cat "$m"
    elif [ -f "$VROOT/$1/application.zip" ]; then
        unzip -p "$VROOT/$1/application.zip" manifest.webmanifest 2>/dev/null
    else
        cat "$VROOT/cached/$1/manifest.webmanifest" 2>/dev/null
    fi
}

flipfull_apps() {
    for m in "$USERINIT"/apps/*/manifest.webmanifest; do
        json_value origin < "$m"
    done
    ls "$USERINIT/overlays" 2>/dev/null
}

# the phone's own apps and Flipfull's, which Flipstore may never replace.
# Cached: api-daemon's database and Flipfull's file list say when it changes,
# and the store commands ask for this on every install and uninstall.
store_protected() {
    mkdir -p "$STATE"
    key="# $(stat -c %Y "$APPS_DB" "$APPS_DB-wal" "$MANIFEST" 2>/dev/null | tr '\n' ' ')"
    if [ "$(head -1 "$STATE/protected" 2>/dev/null)" = "$key" ]; then
        tail -n +2 "$STATE/protected"
        return 0
    fi
    pre=$(preloaded_apps)
    [ -n "$pre" ] || die "can't read the phone's app list"
    { echo "$key"; printf '%s\n' "$pre"; flipfull_apps; } > "$STATE/protected.tmp" &&
        mv -f "$STATE/protected.tmp" "$STATE/protected" || return 1
    tail -n +2 "$STATE/protected"
}

store_name_ok() { case $1 in ''|-*|*[!a-z0-9.-]*) return 1 ;; esac; }

# an https URL made of the characters cgi-bin/store passes on; no forks
# (the charset sits in a variable: & and ; can't appear in a case pattern)
store_url_ok() {
    bad='*[!A-Za-z0-9._~:/?#@!$&+,;=%-]*'
    case $1 in
        $bad|https://) return 1 ;;
        https://?*) return 0 ;;
    esac
    return 1
}

store_sha_ok() {
    case $1 in *[!0-9a-f]*) return 1 ;; esac
    [ ${#1} -eq 64 ]
}

store_official_url() {
    case $1 in
        "https://github.com/$STORE_REPO/releases/latest/download/flipstore.zip") return 0 ;;
        "https://github.com/$STORE_REPO/releases/download/"*"/flipstore.zip")
            tag=${1#"https://github.com/$STORE_REPO/releases/download/"}
            tag=${tag%/flipstore.zip}
            case $tag in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
            return 0 ;;
    esac
    return 1
}

store_record() {
    mkdir -p "$CONFIG"
    { grep -v "^$1 " "$STORE_RECORDS" 2>/dev/null; [ -z "$2" ] || echo "$1 $2"; } > "$STORE_RECORDS.tmp" &&
        mv -f "$STORE_RECORDS.tmp" "$STORE_RECORDS"
}

store_fetch() {
    code=$(curl -sL --connect-timeout 20 --max-time "$4" --max-filesize "$3" -o "$2" -w '%{http_code}' "$1")
    rc=$?
    [ $rc = 0 ] && [ "$code" = 200 ] && return 0
    case $rc:$code in
        63:*) echo "it's bigger than $(($3 / 1048576)) MB" ;;
        *:000) echo "no connection" ;;
        0:*) echo "HTTP $code" ;;
        *) echo "curl error $rc" ;;
    esac
    return 1
}

store_stage() {
    rm -rf "$STORE_DIR" && mkdir -p "$STORE_DIR" && chmod 0700 "$STORE_DIR" || die "can't write $STORE_DIR"
    echo "$1" > "$STORE_DIR/url"
    why=$(store_fetch "$1" "$STORE_DIR/app.zip" $STORE_MAX 300) || die "couldn't download $1: $why"
    sum=$(sha256sum "$STORE_DIR/app.zip" | cut -d' ' -f1)
    if [ -n "$2" ] && [ "$2" != "$sum" ]; then
        rm -rf "$STORE_DIR"
        die "the download doesn't match its checksum"
    fi
    unzip -p "$STORE_DIR/app.zip" manifest.webmanifest > "$STORE_DIR/manifest.webmanifest" 2>/dev/null
    [ -s "$STORE_DIR/manifest.webmanifest" ] || die "not a KaiOS app: the zip has no manifest.webmanifest"
    printf 'sha256\t%s\nsize\t%s\nmanifest\n' "$sum" "$(stat -c %s "$STORE_DIR/app.zip")"
    cat "$STORE_DIR/manifest.webmanifest"
}

# every "name" in the manifest makes a candidate app name on the phone; all of
# them must be plain ASCII and none may be a protected app's name
store_unnamed() {
    names=$(tr -d '\n' < "$1" | grep -o '"name" *: *"[^"]*"' | sed 's/^.*: *"//; s/"$//')
    [ -n "$names" ] || die "the app's manifest has neither an origin nor a name"
    # a backslash could hide a quote, and Unicode letters can lowercase to ASCII ones
    case $names in *\\*) die "the app's manifest has no origin, and its name has characters Flipfull can't check" ;; esac
    printf '%s\n' "$names" | LC_ALL=C grep -q '[^ -~]' &&
        die "the app's manifest has no origin, and its name has characters Flipfull can't check"
    names=$(printf '%s\n' "$names" | tr A-Z a-z | tr -cd 'a-z0-9\n')
    for n in $names; do
        echo "$3" | grep -qx "$n" && die "the app would take the name $n, one of the phone's or Flipfull's own apps"
    done
    printf '%s\n' "$names" | grep -qxF "$2" || die "the app's name doesn't make $2"
    echo "$2"
}

# `flipfull store installed`: every app, its version and where it came from.
# One sqlite query and one awk pass; the old loop ran about ten processes per
# app (an awk, a grep and two json_value pipelines of four each), which is the
# slowest thing the Flipstore app asks for - it runs at every start.
store_installed() {
    rows=$("$SQLITE" -init /dev/null -separator ' ' "$APPS_DB" \
        "SELECT name, preloaded, IFNULL(NULLIF(update_url, ''), '-') FROM apps
         WHERE preloaded = 0 OR IFNULL(update_url, '') != '' ORDER BY name") || return 1
    [ -n "$rows" ] || return 0
    ours=$(flipfull_apps)
    tmp=/data/local/tmp/flipstore-inst.$$
    rm -rf "$tmp" && mkdir -p "$tmp" && chmod 0700 "$tmp" || return 1
    # apps whose manifest isn't a plain file (rare) get it unpacked once, here
    printf '%s\n' "$rows" | while read -r name p u; do
        [ -f "$VROOT/$name/manifest.webmanifest" ] || app_manifest "$name" > "$tmp/$name" 2>/dev/null
    done
    printf '%s\n' "$rows" | awk -v vroot="$VROOT" -v records="$STORE_RECORDS" \
        -v ours="$ours" -v tmp="$tmp" '
    function jval(m, key,    s, pair, a) {
        s = m
        while (match(s, /"[^"]*" *: *"[^"]*"/)) {
            pair = substr(s, RSTART, RLENGTH)
            s = substr(s, RSTART + RLENGTH)
            split(pair, a, /"/)
            if (a[2] == key) return a[4]
        }
        return ""
    }
    BEGIN {
        while ((getline line < records) > 0) {
            i = index(line, " ")
            if (i) src[substr(line, 1, i - 1)] = substr(line, i + 1)
        }
        close(records)
        n = split(ours, o, "\n")
        for (i = 1; i <= n; i++) mine[o[i]] = 1
    }
    {
        name = $1; preloaded = $2; update = $3
        file = vroot "/" name "/manifest.webmanifest"
        m = ""
        while ((getline l < file) > 0) m = m l
        close(file)
        if (m == "") {
            file = tmp "/" name
            while ((getline l < file) > 0) m = m l
            close(file)
        }
        source = (name in src) ? src[name] : ""
        is_mine = (name in mine)
        if (source == "" && is_mine && preloaded == 0) source = "flipfull"
        printf "app\t%s\t%s\t%s\t%s\t%s\t%s\n", name, jval(m, "name"), jval(m, "version"), \
            update, source == "" ? "-" : source, (preloaded == 1 || is_mine) ? 1 : 0
    }'
    rc=$?
    rm -rf "$tmp"
    return $rc
}

# cached by the apps database and the records file, both of which change on
# every install, update and uninstall
store_installed_cached() {
    mkdir -p "$STATE"
    key="# $(cat /proc/sys/kernel/random/boot_id) $(stat -c %Y "$APPS_DB" "$APPS_DB-wal" "$STORE_RECORDS" 2>/dev/null | tr '\n' ' ')"
    if [ "$(head -1 "$STATE/store-inst" 2>/dev/null)" = "$key" ]; then
        tail -n +2 "$STATE/store-inst"
        return 0
    fi
    out=$(store_installed) || { rm -f "$STATE/store-inst"; return 1; }
    { echo "$key"; printf '%s\n' "$out"; } > "$STATE/store-inst.tmp" &&
        mv -f "$STATE/store-inst.tmp" "$STATE/store-inst"
    printf '%s\n' "$out"
}

# is the flipstore feature on? plan's lines, matched whole, without a grep
store_feature_on() {
    case "
$(plan)
" in
        *"
feature flipstore on
"*) return 0 ;;
    esac
    return 1
}

# Flipstore itself, installed or removed as its feature is turned on and off
reconcile_store() {
    url=http://$STORE_ORIGIN.localhost/manifest.webmanifest
    list=$(apps_cmd list)
    apps_ok "$list" || return 0
    installed=0
    case $list in *"$url"*) installed=1 ;; esac
    if echo "$1" | grep -qx "feature flipstore on"; then
        [ $installed = 1 ] && return 0
        (store_stage "https://github.com/$STORE_REPO/releases/latest/download/flipstore.zip" >/dev/null) &&
            install_zip "$STORE_DIR/app.zip" Flipstore && store_record "$STORE_ORIGIN" official
        rm -rf "$STORE_DIR"
    elif [ $installed = 1 ]; then
        apps_ok "$(apps_cmd uninstall "$url")" && echo "uninstalled Flipstore" || echo "error: Flipstore didn't uninstall"
    fi
}

cmd_store() {
    store_feature_on || die "turn on Flipstore app store in the Flipfull app first"
    case $1 in
        info)
            printf 'store-repo\t%s\n' "$STORE_REPO" ;;
        get)
            store_url_ok "$2" || die "not an https URL: $2"
            tmp=$STORE_DIR-get.$$
            why=$(store_fetch "$2" "$tmp" 2097152 60) || {
                rm -f "$tmp"
                die "couldn't get $2: $why"
            }
            cat "$tmp"
            rm -f "$tmp" ;;
        stage)
            store_url_ok "$2" || die "not an https URL: $2"
            [ -z "$3" ] || store_sha_ok "$3" || die "not a sha256: $3"
            store_stage "$2" "$3" ;;
        install)
            [ $# -eq 3 ] || die "usage: flipfull store install ORIGIN SOURCE"
            [ -f "$STORE_DIR/app.zip" ] || die "nothing downloaded to install"
            m=$STORE_DIR/manifest.webmanifest
            grep -q '\\u' "$m" && die "the app's manifest has \\u escapes; Flipstore can't check which app it is"
            protected=$(store_protected) || exit 1
            case $(awk '{ n += gsub(/"origin"/, "") } END { print n + 0 }' "$m") in
                0) origin=$(store_unnamed "$m" "$2" "$protected") || exit 1 ;;
                1) origin=$(json_value origin < "$m" | tr A-Z a-z) ;;
                *) die "the app's manifest names more than one origin" ;;
            esac
            store_name_ok "$origin" || die "the app's manifest has no usable origin"
            [ "$origin" = "$2" ] || die "the download is $origin, not $2"
            echo "$protected" | grep -qx "$origin" &&
                die "$origin is one of the phone's or Flipfull's own apps; Flipstore won't replace it"
            source=$3
            if [ "$origin" = "$STORE_ORIGIN" ]; then
                store_official_url "$(cat "$STORE_DIR/url")" ||
                    die "Flipstore only updates from github.com/$STORE_REPO"
                source=official
            else
                store_url_ok "$source" || die "not a source: $source"
            fi
            install_zip "$STORE_DIR/app.zip" "$origin" || exit 1
            case $(apps_cmd list) in
                *"http://$origin.localhost/manifest.webmanifest"*) ;;
                *) die "the phone installed it under another name than $origin" ;;
            esac
            store_record "$origin" "$source"
            rm -rf "$STORE_DIR" ;;
        uninstall)
            store_name_ok "$2" || die "not an app name: $2"
            [ "$2" = "$STORE_ORIGIN" ] && die "turn off Flipstore app store in the Flipfull app to remove Flipstore"
            protected=$(store_protected) || exit 1
            echo "$protected" | grep -qx "$2" && die "$2 is one of the phone's or Flipfull's own apps"
            apps_ok "$(apps_cmd uninstall "http://$2.localhost/manifest.webmanifest")" || die "$2 didn't uninstall"
            store_record "$2"
            echo "uninstalled $2" ;;
        installed)
            store_installed_cached ;;
        *)
            die "usage: flipfull store info | get URL | stage URL [SHA256] | install ORIGIN SOURCE | uninstall NAME | installed" ;;
    esac
}
