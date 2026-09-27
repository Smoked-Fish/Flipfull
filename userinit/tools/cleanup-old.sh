#!/system/bin/sh

DRY=0
SCOPE=all
for a in "$@"; do
    case "$a" in
        --dry-run)       DRY=1 ;;
        --userinit-only) SCOPE=userinit ;;
        *) echo "usage: $0 [--dry-run] [--userinit-only]"; exit 2 ;;
    esac
done

UI=/data/local/userinit
TMP=/data/local/tmp
removed=0

rm_path() {
    [ -e "$1" ] || [ -L "$1" ] || return 0
    if [ "$DRY" = 1 ]; then
        echo "would remove  $1   ($2)"
    else
        rm -rf "$1" && echo "removed       $1   ($2)"
    fi
    removed=$((removed + 1))
}

for s in 04-mount-hosts-overlay 05-mount-launcher-overlay 06-mount-wallpaper-overlay \
         07-mount-shared-overlay 08-mount-system-overlay 09-mount-keyboard-overlay \
         10-ttl-override; do
    rm_path "$UI/post-fs-data.d/$s.sh" "old stage script"
done
for s in 00-example 20-tether-ttl 30-stt-server; do
    rm_path "$UI/boot-completed.d/$s.sh" "old stage script (now services/)"
done
rm_path "$UI/hosts" "moved to etc/hosts"
rm_path "$UI/bin/ttlfix" "moved to services/tether-ttl/"

if [ "$SCOPE" = userinit ]; then
    [ "$removed" = 0 ] && echo "nothing old in $UI"
    exit 0
fi

if grep -q "/local/webapps/overlay/" /proc/self/mountinfo 2>/dev/null; then
    echo "The old overlays in /data/local/webapps/overlay are still mounted."
    echo "Reboot into the new layout first, then run the cleanup again."
    exit 1
fi
for p in $(pidof stt-server 2>/dev/null); do
    case "$(readlink /proc/$p/exe 2>/dev/null)" in
        /data/local/stt/*)
            echo "stt-server is still running from /data/local/stt; reboot first."
            exit 1 ;;
    esac
done

rm_path /data/local/webapps/overlay "old overlay location (now $UI/overlays)"
rm_path /data/local/stt "old STT service location (now $UI/services/stt)"
for d in /dev /mnt $TMP; do
    rm_path "$d/.ttlfix" "old ttlfix fallback copy"
done

rm_path $TMP/dictate "Dictate installer temp"
rm_path $TMP/stt "STT test files"
rm_path $TMP/30-stt-server.sh "old STT boot script copy"
for f in ap.sh vm.sh collect.sh cpumeasure.sh threads.sh kaicap drmprops probe.dex probe.png; do
    rm_path "$TMP/$f" "now in $UI/tools or $UI/bin"
done
rm_path $TMP/t1 "threads.sh temp"
rm_path $TMP/t2 "threads.sh temp"
rm_path $TMP/dump "collect.sh output"
rm_path $TMP/drmblobs "drmprops output (drmprops recreates it)"
rm_path $TMP/dump.tar "collect.sh output"
for f in rec.raw rec.mp4 fb.raw jfk.wav short.wav; do
    rm_path "$TMP/$f" "test recording"
done
rm_path $TMP/artdata "ap.sh / vm.sh ART cache (recreated on use)"

for f in /data/b2g/mozilla/*.default/user.js; do
    [ -f "$f" ] || continue
    old=$(awk '/^\/\/ >>> userinit/{b=1} /^\/\/ <<< userinit/{b=0; next}
               !b && /"(voice-input\.supported-types|javascript\.options\.mem\.gc_allocation_threshold_mb|javascript\.options\.mem\.gc_incremental_slice_ms)"/' "$f")
    [ -n "$old" ] || continue
    removed=$((removed + 1))
    if [ "$DRY" = 1 ]; then
        echo "would remove from $f:"
    else
        awk '/^\/\/ >>> userinit/{b=1} /^\/\/ <<< userinit/{print; b=0; next}
             b || !/"(voice-input\.supported-types|javascript\.options\.mem\.gc_allocation_threshold_mb|javascript\.options\.mem\.gc_incremental_slice_ms)"/' \
            "$f" > "$f.tmp" && cat "$f.tmp" > "$f" && rm -f "$f.tmp"
        echo "removed from $f:"
    fi
    echo "$old" | sed 's/^/    /'
done

[ "$removed" = 0 ] && echo "nothing old found"

echo
echo "Left alone in $TMP (not from these projects, or system files):"
ls -A $TMP 2>/dev/null | grep -vE '^(dictate|stt|30-stt-server\.sh|ap\.sh|vm\.sh|collect\.sh|cpumeasure\.sh|threads\.sh|kaicap|drmprops|probe\.(dex|png)|t1|t2|dump|drmblobs|dump\.tar|rec\.raw|rec\.mp4|fb\.raw|jfk\.wav|short\.wav|artdata|\.ttlfix)$' | sed 's/^/    /'
exit 0
