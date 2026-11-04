# b2g asks for imsd's imsservicemanager before b2g_telephony_binder has been registered.
# It asks 3 times for 5 seconds, so we wait for 15 seconds for no reason.

omni=/system/b2g/omni.ja
copy=$STATE/omni.ja
# the stock omni.ja this was made for and what the copy must come out as
STOCK_MD5=d59cdd75714fbabe9c6dbe222818faf5
COPY_MD5=8a301a003f1640ccc7f002c27f8ec41c
# modules/ImsRegService.sys.mjs in it: offset, size, md5 once edited, and
# where the zip keeps its CRC-32 (local header, central directory)
MOD_AT=8915584
MOD_SIZE=39835
MOD_MD5=4315527c418543ac956611e6c6c957d5
CRC_AT="8915539 29980629"
CRC='\x36\x85\x23\x63'

make_copy() {
    set -- $(md5sum "$omni")
    if [ "$1" != $STOCK_MD5 ]; then
        # not tried again until omni.ja changes
        echo "$key" > "$copy.key"
        log "$omni isn't the one this was made for - stock in use"
        return 1
    fi
    _m=$STATE/ImsRegService.sys.mjs

    tail -c +$((MOD_AT + 1)) "$omni" | head -c $MOD_SIZE | sed '/^[[:space:]]*\/\//d
/^  init() {$/{
n
s/^    if (IMS_ENABLED && lazy\.gImsServiceManager) {$/    if (IMS_ENABLED \&\& !this._firstTryLater) {\n      this._firstTryLater = true;\n      this.debug("first binder try on the retry timer, so startup goes on without waiting");\n      this.timer = Cc["@mozilla.org\/timer;1"].createInstance(Ci.nsITimer);\n      this.timer.initWithCallback(this, 5000, Ci.nsITimer.TYPE_ONE_SHOT);\n      return;\n    }\n&/
}' > "$_m"
    _n=$(wc -c < "$_m")
    head -c $((MOD_SIZE - _n)) /dev/zero | tr '\0' ' ' >> "$_m"
    set -- $(md5sum "$_m")
    if [ "$1" != $MOD_MD5 ]; then
        rm -f "$_m"
        log "editing ImsRegService.sys.mjs came out different - stock in use"
        return 1
    fi
    cp "$omni" "$copy.tmp" &&
        dd if="$_m" of="$copy.tmp" bs=1 seek=$MOD_AT conv=notrunc 2>/dev/null
    for _at in $CRC_AT; do
        printf "$CRC" | dd of="$copy.tmp" bs=1 seek=$_at conv=notrunc 2>/dev/null
    done
    rm -f "$_m"
    set -- $(md5sum "$copy.tmp")
    if [ "$1" != $COPY_MD5 ]; then
        rm -f "$copy.tmp"
        log "the copy of omni.ja came out different - stock in use"
        return 1
    fi
    label_system_file "$copy.tmp"
    mv -f "$copy.tmp" "$copy"
    log "made $copy"
}

if mounted_on "$omni"; then
    log "$omni already has something mounted on it - skipped"
    exit 0
fi

key=$(stat -c '%s %Y %i' "$omni")
_was=
[ -f "$copy.key" ] && read -r _was < "$copy.key"
if [ "$_was" = "$key" ]; then
    if [ ! -f "$copy" ]; then
        log "no copy of this omni.ja ($copy) - stock in use"
        exit 0
    fi
else
    rm -f "$copy" "$copy.key"
    make_copy || exit 0
    echo "$key" > "$copy.key"
fi
bind_over "$copy" "$omni"
