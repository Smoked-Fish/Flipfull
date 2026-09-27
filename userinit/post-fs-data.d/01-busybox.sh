#!/system/bin/sh

BASE=/data/local/userinit
BB="$BASE/bin/busybox"
BBX="$BASE/bin/bbx"

log() { echo "[busybox] $*"; }

if [ ! -f "$BB" ]; then
    log "binary $BB not found - skipping"
    exit 0
fi
chmod 0755 "$BB" 2>/dev/null

if ! "$BB" true 2>/dev/null; then
    log "binary present but won't execute (wrong ABI, or noexec mount?) - skipping"
    exit 1
fi

VER=$("$BB" 2>&1 | head -1)
log "found: $VER"

mkdir -p "$BBX"
if "$BB" --install -s "$BBX" 2>/dev/null; then
    N=$(ls "$BBX" 2>/dev/null | wc -l)
    log "installed $N applet symlinks in $BBX"
else
    log "busybox --install failed, linking a core set by hand"
    for a in timeout pkill killall pgrep vi awk sed tar gzip gunzip \
             wget nc less find xargs grep head tail sort uniq stat \
             xxd od hexdump du df free ps top kill mount umount id; do
        ln -sf "$BB" "$BBX/$a" 2>/dev/null
    done
fi

export PATH="$BBX:$PATH"

PROFILE="$BASE/busybox-path.sh"
echo "export PATH=$BBX:\$PATH" > "$PROFILE" 2>/dev/null

log "done - tools in $BBX (e.g. $BBX/timeout)"
exit 0
