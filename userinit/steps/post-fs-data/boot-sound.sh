if src=$(boot_media poweron-sound.wav); then
    label_system_file "$src"
    bind_over "$src" /system/media/poweron-sound.wav /system/media/poweron-sound_metro.wav \
        /system/media/poweron-sound_tcl.ogg
fi
