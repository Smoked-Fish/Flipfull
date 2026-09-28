# Flipfull

Mods for the TCL Flip 4 5G (T440W, KaiOS 4.0). Each one is turned on and off
in the Flipfull app on the phone. The list is in `userinit/features.ini`.

Needs a rooted phone (`adb root` works) with the boot hook from `src/boot-hook`.

## Install

Get `flipfull-<version>.zip` from Releases, unzip it, plug in the phone and run
`install.bat` (Windows) or `sh install.sh`. Updates can be installed from the
app: Options > Check for updates.

From the repo:

    python flip4.py install
    python flip4.py release
