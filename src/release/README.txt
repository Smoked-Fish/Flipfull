Flipfull for the TCL Flip 4 5G (T440W)

Needs a rooted phone ("adb root" works) with the Flipfull boot hook, and adb.
If adb isn't installed, put the platform-tools folder next to this file.

Install or update:
1. Connect the phone with USB.
2. Windows: install.bat. Mac or Linux: sh install.sh
3. Open Flipfull on the phone, turn on what you want, and reboot.

Black screen after a reboot:
    adb shell touch /data/local/userinit/disable
    adb reboot
Flipfull stays off until you delete that file.
