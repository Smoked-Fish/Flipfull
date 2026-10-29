f=$API_DAEMON/app-update-config.json
if [ ! -f "$f" ]; then
    echo '{"enabled":true,"conn_type":"Any","delay":86400,"last_check":0}' > "$f"
    chmod 0600 "$f"
    chcon u:object_r:api_data_file:s0 "$f" 2>/dev/null
fi
edit_file "$f" 's/"enabled":true/"enabled":false/'
