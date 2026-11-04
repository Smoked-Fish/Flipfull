if src=$(boot_media bootanimation.zip); then
    label_system_file "$src"
    bind_over "$src" /system/media/bootanimation.zip /system/media/bootanimation_metro.zip \
        /system/media/bootanimation_tcl.zip
fi
if src=$(boot_media bootanimation_external.zip); then
    label_system_file "$src"
    bind_over "$src" /system/media/bootanimation_external.zip /system/media/bootanimation_external_mpcs.zip \
        /system/media/bootanimation_external_tcl.zip
fi
