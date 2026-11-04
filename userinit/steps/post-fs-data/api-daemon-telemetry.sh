edit_file "$API_DAEMON/config.toml" '/^\[telemetry\]/,/^\[/s/^enabled *= *true/enabled = false/'
