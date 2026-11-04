src=$USERINIT/etc/ads-sdk-stub.js
served=$(http_root)/sdk/ads/ads-sdk.min.js
original=/system/kaios/http_root/sdk/ads/ads-sdk.min.js

if [ ! -s "$src" ]; then
    log "$src missing - real ads SDK in use"
    exit 0
fi
from=$served
[ -f "$from" ] || from=$original
ctx=$(ls -Z "$from" 2>/dev/null | awk '{ print $1 }')
case $ctx in
    u:object_r:*) label_system_file "$src" "$ctx" ;;
    *) label_system_file "$src" ;;
esac
bind_over "$src" "$served" "$original"
