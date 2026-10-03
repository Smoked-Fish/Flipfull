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

<!-- FEATURES:START -->
## Features

### Ads and Privacy

| Feature | About | Default | Reboot |
|---|---|---|---|
| **Block system updates** | A system update removes root and Flipfull. This keeps the system updater off, blocks TCL's and KaiOS's update servers and stops the phone's update checks. | On | Yes |
| **Block ads** | Apps that ask KaiAds for an ad get none. The ad servers are blocked and the ads SDK is replaced with a stub. | Off | Yes |
| **Block KaiStore auto-updates** | Apps stop updating on their own. You can still update them in KaiStore. | Off | Yes |

### Gecko Preferences

| Feature | About | Default | Reboot |
|---|---|---|---|
| **Block usage reports** | KaiOS's event logger, api-daemon app usage reports, Mozilla's telemetry, and the servers KaiOS and TCL send reports to are blocked. | Off | Yes |
| **Tracker blocking** | The browser and apps block known trackers, with Mozilla's lists that are already on the phone. | Off |  |
| **Speech recognition for websites** | Websites that use the Web Speech API get their speech recognized on the phone, by KaiVA's speech service. I don't know if this will ever be used. | Off |  |
| **Smoother apps** | The JavaScript memory manager is tuned for 1.6 GB of RAM instead of 256 MB | Off |  |
| **Website crash fix** | Prevents websites that send both Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy from crashing | Off |  |

### Home Screen

| Feature | About | Default | Reboot |
|---|---|---|---|
| **Home screen shortcuts** | Settings > Display > Home Screen Shortcuts picks an app for each arrow key, and for holding 0 or 2-9 in the dialer. | Off |  |
| **No side menu** | Removes side menu on the home screen, and the clock and carrier name are centered. | Off |  |
| **No App Folders** | Games and utilities are listed with the other apps instead of in two folders. Turn it off to get the folders back. | Off |  |
| **Seconds on the clock** | The home screen clock shows the seconds next to the minutes. | Off |  |
| **Carrier name: Metro** | The home screen calls a Metro by T-Mobile SIM just Metro (and Metro Wi-Fi Calling with Wi-Fi Calling). | Off |  |
| **Animated wallpapers** | MP4, GIF and WebP wallpapers, set like any other. They play only while you can see them. MP4 and WebP support is unfinished. | Off |  |

### Outer Screen

| Feature | About | Default | Reboot |
|---|---|---|---|
| **Next alarm on the outer screen** | The outer screen shows your next alarm under the clock. | Off |  |
| **Album cover on the outer screen** | While Music plays, the outer screen shows the song's album cover behind the clock, with a bar for how far into the song you are. It needs Music without ads, which is turned on with it. | Off |  |
| **Skip tracks with the phone closed** | While music plays and the phone is closed, hold Volume up for the next track or Volume down for the previous one. If the outer screen is dark, the first press only lights it, unless Volume keys with the screen off is on. | Off |  |
| **Volume keys with the screen off** | While music plays, Volume up and down change the volume at the first press even when the screen is off, open or closed, instead of only lighting the screen. | Off |  |
| **Pause with the quick access button** | With the phone closed and the outer screen lit, one press of the quick access button on the outside pauses the music, and another plays it again. With the outer screen dark, a press only lights it. Two presses (camera) and three (quick call) work as before. | Off |  |
| **Outer screen timeout** | Settings > Display > Sub-screen timeout: how long the outer screen stays lit, from 10 seconds (default) up to 10 minutes, or never if you really want that for some reason. Longer times use more battery. | Off |  |

### Calls and Voice

| Feature | About | Default | Reboot |
|---|---|---|---|
| **Call recording** | Settings > Call Settings > Call Recording: record both sides of a call when you press Left, or every call. Recordings are .m4a files in the callrecording folder. There is about a half second of delay when turning on call recording. Recording laws differ, some places require everyone on the call to agree. | Off |  |
| **KaiVA voice assistant** | A voice assistant that works without the internet. Adds many more settings for you to explore in the KaiVA app too. | Off |  |
| **Dictation in text fields** | Hold OK in any text field except passwords to dictate, recognized on the phone by KaiVA. | Off |  |
| **Music without ads** | No banner or radio ads in the Music app. | Off |  |
| **Video without ads** | Video keeps its YouTube picks, without the ad at start, the ad above the video list or the ads code. | Off |  |
| **Video without YouTube** | Video no longer suggests YouTube searches. It needs Video without ads, which is turned on with it. | Off |  |
| **Messages redesign** | A denser Messages app: about six conversations or a screenful of texts at a time instead of three, a dark theme, and settings for text size, accent color, spacing, message style and times. They are at the top of Messages > Options > Settings. | Off |  |
| **Steady camera frame rates** | Adds video profile for at 24 frames. Flipcam (name pending), from Flipstore, uses them to keep its viewfinder steady in the dark instead of dropping to 10 frames a second, and to record 1080p and 720p video at 24 as well as 30. The stock Camera doesn't use them and works as before. | Off | Yes |

### System

| Feature | About | Default | Reboot |
|---|---|---|---|
| **Google accounts** | Google blocks KaiOS's own sign-in, so adding a Google account needs your own sign-in client: see Options > Google sign-in client. Accounts added with it stop syncing if you turn this off. | Off |  |
| **Your start-up animation** | The start-up animation in the boot folder of the phone's storage (bootanimation.zip, and bootanimation_external.zip for the outer screen) instead of the carrier's. | Off | Yes |
| **Your power-off animation** | The power-off animation in the boot folder of the phone's storage (carrier_power_off.mp4) instead of the carrier's. The MP4 also controlls the power off sound. | Off | Yes |
| **Your start-up sound** | The start-up sound in the boot folder of the phone's storage (poweron-sound.wav) instead of the carrier's. A short silent file makes the phone start silently. | Off | Yes |
| **Your start-up logo** | The logo shown after the start-up animation while the phone loads (initlogo.png) in the boot folder of the phone's storage, instead of the carrier's. | Off | Yes |
| **Network type in SIM details** | Settings shows the preferred network type (5G, LTE, 3G) in the SIM's details, which carrier builds hide. | Off |  |
| **No Battery Full notification** | The phone no longer posts a Battery Full notification when it finishes charging. The charging sound and the low battery warning stay. | Off |  |

<!-- FEATURES:END -->
