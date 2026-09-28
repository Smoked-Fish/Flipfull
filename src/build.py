







import configparser
import hashlib
import json
import re
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
BASE = SRC / "overlays" / "base"
USERINIT = ROOT / "userinit"

# stock app md5 where base/ isn't a copy of it
STOCK_MD5 = {
    "shared": "8aba4d99da9c602cfe76eb22c041eafd",
    "wallpaper": "a0499ffb65d077bc3263f4b16b687692",
}


def on(feature):
    return f'!!(window.FlipfullFeatures&&FlipfullFeatures["{feature}"])'


FEATURES_SCRIPT = '    <script src="http://127.0.0.1/flipfull/features.js"></script>\n'

SYSTEM_SCRIPTS = ('    <script defer="" src="js/live_wallpaper.js"></script>\n'
                  '    <script defer="" src="js/flipfull_system.js"></script>\n')
MAPS_SCRIPT = '    <script defer="" src="js/flipfull_maps.js"></script>\n'

HARDWARE_BUTTONS = [
    # track-skip
    ("js/hardware_buttons.js",
     '.prototype.repeat=function(){this.repeating=!0,this.repeatCount++,',
     '.prototype.repeat=function(){if(!this.repeating&&window.FlipfullMedia&&'
     'window.FlipfullMedia.hold(this.direction))return void(this.repeating=!0);'
     'this.repeating=!0,this.repeatCount++,'),
    # volume-keys
    ("js/hardware_buttons.js",
     'turnscreenOnHandle=function(e){this.browserKeyEventManager.screenOff()&&('
     '"qd-call-button-press"!==this.browserKeyEventManager.getButtonEventType(e)&&(',
     'turnscreenOnHandle=function(e){(this.flipfullScreenWasOff=this.browserKeyEventManager.screenOff())&&('
     '"qd-call-button-press"!==this.browserKeyEventManager.getButtonEventType(e)&&'
     '!(window.FlipfullMedia&&FlipfullMedia.passKey(e))&&('),
    ("js/hardware_buttons.js",
     'if(this.qdProcess(e,s),this.browserKeyEventManager.screenOff())return',
     'if(this.qdProcess(e,s),this.browserKeyEventManager.screenOff()&&'
     '!(window.FlipfullMedia&&FlipfullMedia.passKey(e)))return'),
    # play-pause-button
    ("js/hardware_buttons.js",
     'if(clearTimeout(this.qdTimer),this.qdCount++,this.qdTimer=setTimeout(()=>{var e;',
     'if(clearTimeout(this.qdTimer),this.qdCount++||window.FlipfullMedia&&'
     'FlipfullMedia.quickPress(this.flipfullScreenWasOff,this._isCalling),'
     'this.qdTimer=setTimeout(()=>{var e;window.FlipfullMedia&&FlipfullMedia.quickPresses(this.qdCount);'),
]

INITLOGO = SRC / "overlays" / "system" / "resources" / "branding" / "initlogo_flipfull.png"

NO_SIDE_MENU_CLASS = "flipfull-no-side-menu"
NO_SIDE_MENU = [
    ("dist/app.bundle.js",
     'c.default.createElement(I.default,{ref:function(t){e.panels.sidemenu=t}})',
     on("no-side-menu") + '?null:c.default.createElement(I.default,{ref:function(t){e.panels.sidemenu=t}})'),
    ("dist/app.bundle.js",
     'case"ArrowLeft":"T435V"!==N.default.getBuildCodeName()&&',
     'case"ArrowLeft":!' + on("no-side-menu") + '&&"T435V"!==N.default.getBuildCodeName()&&'),
]

FOLDERS = [
    ("dist/app.bundle.js",
     'X=X.concat(JSON.parse(i)||(n<=256?[]:r))',
     'X=X.concat(' + on("no-folders") + '?(localStorage.setItem("flipfullNoFolders","1"),'
     '(JSON.parse(i)||(n<=256?[]:r)).filter(function(e){'
     'return"games"!==e.basisname&&"utilities"!==e.basisname})):'
     'function(s,d){if(s&&localStorage.getItem("flipfullNoFolders")){'
     'd.forEach(function(f){s.some(function(e){return e.basisname===f.basisname})||s.push(f)});'
     'localStorage.removeItem("flipfullNoFolders")}return s||d}(JSON.parse(i),n<=256?[]:r))'),
    ("dist/app.bundle.js",
     'J=256===n?["Carrier"]:["Games","Carrier","Utilities"]',
     'J=256===n||' + on("no-folders") + '?["Carrier"]:["Games","Carrier","Utilities"]'),
]

CLOCK_SECONDS = [
    ("dist/app.bundle.js",
     'this.timer=setTimeout(function(){e.start()},1e3*(60-t.getSeconds()))',
     'this.timer=setTimeout(function(){e.start()},' + on("clock-seconds")
     + '?1020-t.getMilliseconds():1e3*(60-t.getSeconds()))'),
    ("dist/app.bundle.js", 'm2:d[1],ampm:c})', 'm2:d[1],ampm:c,flipfullSeconds:("0"+e.getSeconds()).slice(-2)})'),
    ("dist/app.bundle.js",
     'p.default.createElement("div",{className:"clock-ampm","data-hour-24":!window.api.hour12},this.state.ampm)',
     on("clock-seconds") + '?p.default.createElement("div",{className:"flipfull-clock-side"},'
     'p.default.createElement("div",{className:"clock-ampm","data-hour-24":!window.api.hour12},this.state.ampm),'
     'p.default.createElement("div",{className:"flipfull-clock-seconds"},this.state.flipfullSeconds))'
     ':p.default.createElement("div",{className:"clock-ampm","data-hour-24":!window.api.hour12},this.state.ampm)'),
]
CLOCK_SECONDS_CSS = (
    ".flipfull-clock-side{display:flex;flex-direction:column;justify-content:flex-end;"
    "margin-inline-start:.3rem;margin-bottom:.3rem}"
    ".flipfull-clock-side .clock-ampm{align-self:flex-start;margin:0;line-height:1.6rem}"
    ".flipfull-clock-seconds{font-size:2.2rem;line-height:2.4rem;font-weight:400}")

METRO_NAME = [
    ("dist/app.bundle.js",
     'n.push({signalLevel:s,carrierName:u,stateL10nId:l,isVoWifi:h})',
     'n.push({signalLevel:s,carrierName:' + on("metro-name")
     + '&&"string"==typeof u?u.replace(/Metro by T-Mobile/gi,"Metro"):u,stateL10nId:l,isVoWifi:h})'),
]

BATTERY_FULL = [
    ("js/battery_overlay.js",
     "    shouldNotifyBatteryFull: function() {\n",
     "    shouldNotifyBatteryFull: function() {\n"
     "      if (" + on("no-battery-full") + ") {\n"
     "        return false;\n"
     "      }\n"),
]

SUBSCREEN_TIMEOUT_ITEM = (
    '        <li role="menuitem" id="flipfull-subscreen-timeout">\n'
    '          <span>Sub-screen timeout</span>\n'
    '          <div class="button icon icon-dialog">\n'
    '            <select data-name="flipfull.subscreen.timeout" data-value-type="integer">\n'
    '              <option value="10">10 seconds</option>\n'
    + "".join(f'              <option value="{v}" data-l10n-id="{l10n}"></option>\n' for v, l10n in (
        (15, "fifteen-seconds"), (30, "thirty-seconds"), (60, "one-minute"), (120, "two-minutes"),
        (300, "five-minutes"), (600, "ten-minutes"), (0, "never"))) +
    '            </select>\n'
    '          </div>\n'
    '        </li>\n')
AUTO_LOCK_ITEM = '        <li role="menuitem" id="auto-lock" class="auto-height hidden">\n'
OUTER_SCREEN_TIMEOUT = [
    ("remote/dist/app.bundle.js",
     ',this._timerID=window.setTimeout(function(){!t.state.lidOpen&&t.attentionScreen.state.show',
     ',this._timerID=null,window.FlipfullOuterScreen&&FlipfullOuterScreen.stayOn()||'
     '(this._timerID=window.setTimeout(function(){!t.state.lidOpen&&t.attentionScreen.state.show'),
    ("remote/dist/app.bundle.js",
     't._timerID=null},this.state.timeout)}},{key:"setOffTimeout"',
     't._timerID=null},window.FlipfullOuterScreen?FlipfullOuterScreen.dimAfter(this.state.timeout,'
     'this.props.timeout):this.state.timeout))}},{key:"setOffTimeout"'),
]

CALL_RECORDING_ITEM = (
    '        <li role="menuitem" id="call-recording-item">\n'
    '          <a class="menu-item">\n'
    '            <span>Call Recording</span>\n'
    '          </a>\n'
    '        </li>\n\n')
ASSISTED_DIALING_ITEM = "        <li role=\"menuitem\" id='menuItem-assisted-dialing' class=\"hidden\">\n"
DISPLAY_ITEM = ('              <a id="menuItem-display" class="menu-item" href="#display" '
                'data-l10n-id="display">Display</a>\n            </li>\n')
HOME_SHORTCUTS_ITEM = ('            <li role="menuitem">\n'
                       '              <a id="menuItem-homeShortcuts" class="menu-item" '
                       'href="#home_shortcuts">Home Screen Shortcuts</a>\n'
                       '            </li>\n')
NETWORK_TYPE_HIDING = (
    "        elements.networkType.classList.add('hidden');\n"
    "        SettingsObserver.getValue('hidemenu.networkType.temp').then((result) => {\n"
    "          DebugHelper.log('hidemenu.networkType.temp = ' + result);\n"
    "          if (result == 1) {\n"
    "            elements.networkType.classList.remove('hidden');\n"
    "          } else {\n"
    "            elements.networkType.classList.add('hidden');\n"
    "          }\n"
    "        }).catch((error) => {\n"
    "          DebugHelper.log('Error getting the value: ' + error);\n"
    "          elements.networkType.classList.add('hidden');\n"
    "        });\n")
EVENT_LOGGER_START = (
    'SettingsObserver.observe("metrics.type",null,function e(t){if("jio"===t)'
    'LazyLoader.load(["../js/app_usage_data.js","../js/app_usage_metrics.js","../js/telemetry.js"],'
    '()=>{window.appUsageMetrics=new AppUsageMetrics,window.appUsageMetrics.start(),new Ps,'
    'window.isJioApplication=!0});else{const e=new Cs;e.start(),window.evlm=e}'
    'SettingsObserver.unobserve("metrics.type",e)});')

GOOGLE_CLIENT = """
// Flipfull (feature google-accounts): your own Google sign-in client instead
// of the one above, read from the phone (`flipfull google-client import`).
window.FlipfullGoogleClient = (function(google) {
  const FILE = '/data/local/userinit/config/google-client.json';
  const stock = { client_id: google.client_id, client_secret: google.client_secret };
  let own = null;
  ['client_id', 'client_secret'].forEach(key => Object.defineProperty(google, key, {
    get: () => (own || stock)[key],
    enumerable: true
  }));
  function load() {
    if (!(window.FlipfullFeatures && window.FlipfullFeatures['google-accounts'])) {
      own = null;
      return Promise.resolve();
    }
    return IOUtils.readJSON(FILE).then(json => {
      own = { client_id: json.web.client_id, client_secret: json.web.client_secret };
    }, () => {
      own = null;
    });
  }
  load();
  return { load };
}(Oauth2Config.google));
"""

RECORDER_KBPS = [8, 16, 32, 64, 96, 128]
RECORDER_STOCK_CHOICES = (
    'v.a.createElement("option",{"data-l10n-id":"settings-bitrate-8k",value:"8000"}),'
    'v.a.createElement("option",{"data-l10n-id":"settings-bitrate-44k",value:"44000"})')
RECORDER_L10N = {
    "en-US": ("Recording Quality", ["Low", "Medium", "Good", "High", "Very high", "Best"],
              "{name} ({kbps} kbps)"),
    "es-US": ("Calidad de grabación", ["Baja", "Media", "Buena", "Alta", "Muy alta", "Máxima"],
              "{name} ({kbps} kbps)"),
    "ko-KR": ("녹음 품질", ["낮음", "보통", "좋음", "높음", "매우 높음", "최고"], "{name}({kbps}kbps)"),
    "zh-CN": ("录音质量", ["低", "中", "良好", "高", "很高", "最佳"], "{name}（{kbps} kbps）"),
}

def zip_names(app):
    with zipfile.ZipFile(BASE / app / "application.zip") as z:
        return z.namelist()


OVERLAYS = {
    "launcher": {
        "patches": [
            ("index.html", '    <script src="js/debug_helper.js"></script>\n',
             FEATURES_SCRIPT + '    <script src="js/debug_helper.js"></script>\n'),
            ("dist/app.bundle.js",
             'ee.default.getSettings().then(function(t){e.forceSettings=t,',
             'ee.default.getSettings().then(function(t){e.forceSettings=t,' + on("home-shortcuts") + '&&'
             '["home.customization.keypress","home.customization.longpress"].forEach(function(k){'
             'SettingsObserver.observe(k,null,function(v){null===v&&"home.customization.keypress"===k?'
             'SettingsObserver.setValue([{name:k,value:[{key:"ArrowRight",type:"manifestUrl",'
             'url:window.AppOrigin?AppOrigin.getManifestURL("camera"):"http://camera.localhost/manifest.webmanifest"}]}])'
             ':e.forceSettings[k]=v})}),'),
            ("dist/app.bundle.js",
             'if("TF"===s.default.getBuildOperatorName()&&"kaios-voiceassistant"===e.name)return!0;',
             'if(!' + on("kaiva") + '&&"TF"===s.default.getBuildOperatorName()&&'
             '"kaios-voiceassistant"===e.name)return!0;'),
            ("dist/app.bundle.js",
             'if("TMO"===s.default.getBuildOperatorName()&&"kaios-voiceassistant"===e.name)return!0;',
             'if(!' + on("kaiva") + '&&"TMO"===s.default.getBuildOperatorName()&&'
             '"kaios-voiceassistant"===e.name)return!0;'),
        ] + NO_SIDE_MENU + FOLDERS + CLOCK_SECONDS + METRO_NAME,
        "rewrites": [
            ("dist/app.bundle.js", lambda text: f'document.documentElement.classList.toggle("{NO_SIDE_MENU_CLASS}",'
             + on("no-side-menu") + ");" + text),
            ("dist/app.style.css", lambda text: text + f"\n.{NO_SIDE_MENU_CLASS} .ClockComponent,"
             f".{NO_SIDE_MENU_CLASS} #simcard-info{{margin-left:0}}\n" + CLOCK_SECONDS_CSS + "\n"),
        ],
    },
    "shared": {
        "patches": [
            ("js/utils/media/image_utils.js",
             "return t===g&&r===u?o:n(e)",
             "return t===g&&r===u&&e.type!==a.GIF?o:n(e)"),
        ],
    },
    "wallpaper": {
        "patches": [
            ("js/pick.js",
             "this.returnResult(!1,{type:e.type,blob:e,name:t,filename:t})",
             "this.returnResult(!1,{type:e.type,blob:e,name:t,"
             "filename:/\\.(mp4|gif|webp)$/i.test(t)?t.split(\"/\").pop():t})"),
        ],
    },
    "system": {
        "patches": [
            ("index.html",
             '    <script defer="" src="js/remote_helper.js"></script>\n',
             FEATURES_SCRIPT + '    <script defer="" src="js/remote_helper.js"></script>\n'),
            ("index_remote.html",
             '    <script src="http://shared.localhost/js/utils/common/app_origin.js"></script>\n',
             FEATURES_SCRIPT + '    <script src="http://shared.localhost/js/utils/common/app_origin.js"></script>\n'),
            ("index.html",
             '    <script defer="" src="js/external_screen_manager.js"></script>\n',
             '    <script defer="" src="js/external_screen_manager.js"></script>\n' + SYSTEM_SCRIPTS + MAPS_SCRIPT),
            ("index_remote.html",
             '    <script defer="" src="remote/dist/app.bundle.js"></script>\n',
             '    <script defer="" src="remote/dist/app.bundle.js"></script>\n' + SYSTEM_SCRIPTS),
            ("js/account_manager/google_authenticator.js",
             "    const codeChallenge = await getChallenge();\n",
             "    await FlipfullGoogleClient.load();\n    const codeChallenge = await getChallenge();\n"),
            ("dist/app.bundle.js", EVENT_LOGGER_START, on("block-telemetry") + "||" + EVENT_LOGGER_START),
            ("js/fota/fotaJs_Loader.js", "\nfotaLoader.init();\n",
             "\n" + on("block-updates") + "||fotaLoader.init();\n"),
        ] + HARDWARE_BUTTONS + BATTERY_FULL + OUTER_SCREEN_TIMEOUT + ([
            ("js/init_logo_handler.js",
             'CustomLogoPath.oslogo.image="tmo"===e?',
             'CustomLogoPath.oslogo.image=' + on("boot-animation") +
             '?`${SYSTEM_RESOURCE}branding/initlogo_flipfull.png`:"tmo"===e?'),
        ] if INITLOGO.is_file() else []),
        "rewrites": [
            ("js/account_manager/oauth2_config.js", lambda text: text + GOOGLE_CLIENT),
        ],
    },
    "settings": {
        "patches": [
            ("index.html",
             '    <script src="http://shared.localhost/js/utils/common/app_origin.js"></script>\n',
             FEATURES_SCRIPT + '    <script src="http://shared.localhost/js/utils/common/app_origin.js"></script>\n'),
            ("index.html", DISPLAY_ITEM, DISPLAY_ITEM + HOME_SHORTCUTS_ITEM),
            ("js/panels/root/panel.js",
             "        RootManager.init();\n",
             "        RootManager.init();\n"
             "        panel.querySelector('#menuItem-homeShortcuts').parentNode.classList.toggle('hidden', !"
             + on("home-shortcuts") + ");\n"),
            ("elements/call.html", ASSISTED_DIALING_ITEM, CALL_RECORDING_ITEM + ASSISTED_DIALING_ITEM),
            ("js/panels/call/panel.js",
             "      'menuItem-assisted-dialing': '#assisted_dialing',\n",
             "      'menuItem-assisted-dialing': '#assisted_dialing',\n"
             "      'call-recording-item': '#call_recording',\n"),
            ("js/panels/call/panel.js",
             "        listElements = panel.querySelectorAll('li');\n",
             "        panel.querySelector('#call-recording-item').classList.toggle('hidden', !"
             + on("call-recording") + ");\n"
             "        listElements = panel.querySelectorAll('li');\n"),
            ("js/panels/carrier_detail/panel.js", NETWORK_TYPE_HIDING,
             "        if (" + on("network-type") + ") {\n"
             "          elements.networkType.classList.remove('hidden');\n"
             "        } else {\n" + NETWORK_TYPE_HIDING + "        }\n"),
            ("elements/display.html", AUTO_LOCK_ITEM, SUBSCREEN_TIMEOUT_ITEM + AUTO_LOCK_ITEM),
            ("js/panels/display/panel.js",
             "        listElements = panel.querySelectorAll('li');\n",
             "        panel.querySelector('#flipfull-subscreen-timeout').classList.toggle('hidden', !"
             + on("outer-screen-timeout") + ");\n"
             "        listElements = panel.querySelectorAll('li');\n"),
        ],
    },
    "callscreen": {
        "patches": [
            ("index.html",
             '    <script defer="" type="application/javascript" src="/js/call_recording.js"></script>\n',
             '    <script defer="" type="application/javascript" src="/js/flipfull_callrec.js"></script>\n'
             '    <script defer="" type="application/javascript" src="/js/call_recording.js"></script>\n'),
            ("js/call_recording.js",
             'navigator.mediaDevices.getUserMedia({audio:{audioSource:"voicecall"}})',
             'FlipfullCallRec.open()'),
            ("js/call_recording.js", 'v=new MediaRecorder(e)', 'v=new FlipfullCallRec.Recorder(e)'),
            ("js/call_recording.js", 'y.push(e.data),b=new Date', 'y.push(e.data),b=v&&v.stoppedAt||new Date'),
            ("js/call_recording.js", 'if(n<d)DUMP(', 'if(n<d||!e.size)DUMP('),
            ("js/call_recording.js", 't=S(l)', 't=FlipfullCallRec.ext||S(l)'),
        ],
    },
    "music": {
        "remove": ["js/ads/kaiads.v5.min.js", ".KaiAds.appinfo.json",
                   "js/ui/banner_ad.js", "js/icecast/radio_ad.js",
                   "js/db.js", "js/ui/views/list_view.js",
                   "js/ui/views/mainlist_view.js", "js/icecast/icecast_view.js"],
        "rewrites": [
            ("js/bind.js", lambda text: music_bind(text)),
            ("js/music.js", lambda text: music_app(text)),
            ("index.html", lambda text: music_index(text)),
            ("style/main.css", lambda text: music_css(text)),
        ] + [(m, lambda text: no_ads_dependency(text)) for m in zip_names("music")
             if m.startswith("manifest") and m.endswith(".webmanifest")],
        "patches": [
            ("index.html", "    <!-- Shared code -->\n", FEATURES_SCRIPT + "    <!-- Shared code -->\n"),
            ("index.html",
             '    <script defer="" type="text/javascript" src="js/bind.js"></script>\n',
             '    <script defer="" type="text/javascript" src="js/bind.js"></script>\n'
             '    <script defer="" type="text/javascript" src="js/flipfull_now_playing.js"></script>\n'),
            ("js/communications.js",
             "MusicComm.prototype.notifyMetadataChanged = function (metadata) {\n",
             "MusicComm.prototype.notifyMetadataChanged = function (metadata) {\n"
             "    FlipfullNowPlaying.metadata(metadata);\n"),
            ("js/communications.js",
             "MusicComm.prototype.notifyStatusChanged = function (info) {\n",
             "MusicComm.prototype.notifyStatusChanged = function (info) {\n"
             "    FlipfullNowPlaying.status(info);\n"),
        ],
    },
    "video": {
        "remove": ["js/ads/kaiads.v5.min.js", "js/ads/fullscreen.js", ".KaiAds.appinfo.json"],
        "patches": [
            ("js/video_utils.js", 'supportKaiAds:"function"==typeof getKaiAd,', 'supportKaiAds:!0,'),
        ],
        "rewrites": [
            ("index.html", lambda text: video_index(text)),
            ("js/video.js", lambda text: video_app(text)),
            ("js/navigation_map.js", lambda text: video_navigation(text)),
            ("js/thumbnail_list.js", lambda text: video_thumbnails(text)),
            ("style/video.css", lambda text: video_css(text)),
        ] + [(m, lambda text: no_ads_dependency(text)) for m in zip_names("video")
             if m.startswith("manifest") and m.endswith(".webmanifest")],
    },
    "soundrecorder": {
        "patches": [
            ("dist/0.bundle.js", RECORDER_STOCK_CHOICES, ",".join(
                f'v.a.createElement("option",{{"data-l10n-id":"settings-bitrate-{k}k",value:"{k * 1000}"}})'
                for k in RECORDER_KBPS)),
            ("dist/0.bundle.js", "this._rate=e?parseInt(e,10):8e3",
             f"this._rate=[{','.join(str(k * 1000) for k in RECORDER_KBPS)}]"
             f".find(function(r){{return r>=(parseInt(e,10)||8e3)}})||{RECORDER_KBPS[-1] * 1000}"),
        ],
        "rewrites": [(m, lambda text, m=m: recorder_locale(text, m)) for m in zip_names("soundrecorder")
                     if m.startswith("locales-obj/")],
    },
    "keyboard": {
        "splices": [
            ("js/keypad.js",
             "Keypad.prototype._startVoiceInput=function(){",
             "Keypad.prototype._clearAllTimers=",
             SRC / "overlays" / "keyboard" / "voice_input.js"),
        ],
        "extra_files": False,
    },
}

def fail(msg):
    sys.exit(f"build failed: {msg}")


class PatchError(Exception):
    pass


def js_group_end(text, i):
    stack = []
    j = i
    while j < len(text):
        c = text[j]
        top = stack[-1] if stack else None
        if top in ('"', "'"):
            if c == "\\":
                j += 1
            elif c == top:
                stack.pop()
        elif top == "`":
            if c == "\\":
                j += 1
            elif c == "`":
                stack.pop()
            elif text.startswith("${", j):
                stack.append("${")
                j += 1
        elif c in "\"'`":
            stack.append(c)
        elif c in "({[" :
            stack.append(c)
        elif c in ")}]":
            stack.pop()
            if not stack:
                return j + 1
        j += 1
    fail(f"unbalanced group at {i}")


def cut(text, start, what, then=""):
    if text.count(start) != 1 or start[-1] not in "({[":
        raise PatchError(f"{what}: found {text.count(start)} times, expected 1")
    i = text.index(start)
    j = js_group_end(text, i + len(start) - 1)
    if then:
        if not text.startswith(then, j):
            raise PatchError(f"{what}: expected {then!r} after it")
        j += len(then)
    return text[:i] + text[j:]


def replace_exact(text, old, new, what, count=1):
    if text.count(old) != count:
        raise PatchError(f"{what}: found {text.count(old)} times, expected {count}")
    return text.replace(old, new)


def check_no_ads(text):
    left = [w for w in ("getKaiAd", "BannerAd", "RadioAd", "banner-ad", "FullscreenAd", "kaiads",
                        "BANNER_AD", "RADIO_AD", "musicBannerAd", "radioBannerAd", "ads-sdk",
                        "bannerAd", "fullscreenAd", "ads-fullscreen")
            if w in text]
    if left:
        raise PatchError(f"still mentions {', '.join(left)}")
    return text


def music_bind(text):
    text = cut(text, "BannerAd={", "BannerAd", then=",")
    text = cut(text, "var RadioAd={", "RadioAd", then=";")
    text = cut(text, "function showFullscreenAd(){", "showFullscreenAd")
    text = replace_exact(text, 'const BANNER_AD_STATES={NOT_INITIALIZED:"NOT_INITIALIZED",ERROR:"ERROR",'
                         'LOADING:"LOADING",READY:"READY"},FULL_COLLAPSE_ANIMATION_DURATION_MS=500;', "",
                         "banner states")
    text = replace_exact(text, 'const RADIO_AD_STATES={NOT_INITIALIZED:"NOT_INITIALIZED",ERROR:"ERROR",'
                         'LOADING:"LOADING",READY:"READY"},RADIO_FULL_COLLAPSE_ANIMATION_DURATION_MS=500;', "",
                         "radio ad states")
    text = replace_exact(text, ',0<Number(window.localStorage.getItem("musicCount"))&&!BannerAd.initialized'
                         '&&BannerAd.init()', "", "banner start", count=2)
    text = replace_exact(text, ",RadioAd.initialized||RadioAd.init()", "", "radio ad start")
    text = replace_exact(text, "if(this.anchor.lastChild)for(;!BannerAd.isBannerAdNode(this.anchor.lastChild);)"
                         "this.anchor.removeChild(this.anchor.lastChild)",
                         "for(;this.anchor.lastChild;)this.anchor.removeChild(this.anchor.lastChild)",
                         "song list clean-up")
    text = replace_exact(text, "{if(RadioAd.isBannerAdNode(this.anchor.lastChild))return;"
                         "this.anchor.removeChild(this.anchor.lastChild)}",
                         "this.anchor.removeChild(this.anchor.lastChild)", "radio list clean-up")
    text = replace_exact(text, "removeNodewithoutBanner", "removeAllNodes", "clean-up name", count=2)
    text = replace_exact(text, ",showFullscreenAd())", ")", "fullscreen ad at start")
    text = replace_exact(text, '"function"==typeof getKaiAd&&', "", "full version (list back key)")
    text = replace_exact(text, '"function"!=typeof getKaiAd||', "", "full version (start)")
    return check_no_ads(text)


def music_app(text):
    text = replace_exact(text, "    let isShowFullscreenAds = false;\n", "", "fullscreen ad flag")
    text = replace_exact(text, "            if (!isShowFullscreenAds) {\n"
                         "                showFullscreenAd();\n"
                         "            }\n", "", "fullscreen ad on return")
    text = replace_exact(text, "typeof getKaiAd === 'function' && e.key !== 'EndCall'",
                         "e.key !== 'EndCall'", "full version (overlay back key)")
    start = "        if (typeof getKaiAd !== 'function' && document.hidden"
    if text.count(start) != 1:
        raise PatchError("list-only version block changed")
    i = text.index(start)
    cond_end = js_group_end(text, text.index("(", i))
    block = text.index("{", cond_end)
    if text[cond_end:block].strip():
        raise PatchError("list-only version block changed")
    end = js_group_end(text, block)
    text = text[:i] + text[end:].lstrip(" ").lstrip("\n")
    return check_no_ads(text)


def music_index(text):
    text = replace_exact(text, '    <script src="js/ads/kaiads.v5.min.js"></script>\n', "", "SDK loader")
    for f in ("js/ui/banner_ad.js", "js/icecast/radio_ad.js"):
        text = replace_exact(text, f'    <!-- <script defer type="text/javascript" data-src="{f}"></script> -->\n',
                             "", f)
    for prefix in ("", "i-"):
        start = f'            <div id="{prefix}banner-ad-placeholder">'
        end = f'<div id="{prefix}banner-ad-container" tabindex="-1"></div>\n'
        if text.count(start) != 1 or text.count(end) != 1:
            raise PatchError(f"{prefix}banner placeholder markup changed")
        text = text[:text.index(start)] + text[text.index(end) + len(end):]
    return check_no_ads(text)


def music_css(text):
    text, n = re.subn(r"[^{}]*banner-ad[^{}]*\{[^}]*\}", "", text)
    if n < 3:
        raise PatchError(f"expected the banner styles, found {n} rules")
    return check_no_ads(text)


def no_ads_dependency(text):
    text = replace_exact(text, ',"dependencies":{"ads-sdk":"1.4.5"}', "", "ads-sdk dependency")
    return check_no_ads(text)


def video_index(text):
    for f in ("js/ads/kaiads.v5.min.js", "js/ads/fullscreen.js"):
        text = replace_exact(text, f'    <script defer="" src="{f}"></script>\n', "", f)
    text = replace_exact(text, '          <div class="banner-ad-placeholder" id="banner-ad-placeholder"></div>\n',
                         "", "banner placeholder")
    return check_no_ads(text)


def video_app(text):
    text = replace_exact(text, "!document.hidden&&fullscreenAd.isEnabled&&fullscreenAd.show(),", "",
                         "fullscreen ad on return")
    text = replace_exact(text, "e!==LAYOUT_MODE.list||fullscreenAd.isDisplaying||(fullscreenAd.isEnabled=!0);",
                         "", "fullscreen ad re-armed in the list")
    text = replace_exact(text, "function thumbnailClickHandler(e){fullscreenAd.isDisplaying||(",
                         "function thumbnailClickHandler(e){(", "no clicks under the fullscreen ad")
    text = replace_exact(text, "fullscreenAd.isEnabled=!1,", "", "fullscreen ad off while playing")
    return check_no_ads(text)


def video_navigation(text):
    text = replace_exact(text, "  var optClickBannerAd = {\n"
                         "    name: 'Go',\n"
                         "    l10nId: 'go',\n"
                         "    priority: 2,\n"
                         "    method: () => thumbnailList.bannerAd.call('click')\n"
                         "  };\n\n", "", "banner Go key")
    text = replace_exact(text, "  var actBannerAd = [optTakeVideo, optClickBannerAd];\n", "", "banner keys")
    text = replace_exact(text, "    if (thumbnailList.fullscreenAd) {\n"
                         "      return;\n"
                         "    }\n", "", "keys ignored under the fullscreen ad")
    text = replace_exact(text, "        setTimeout(() => thumbnailList.getBannerAd(), 0);\n", "", "banner load")
    text = replace_exact(text, "          else if (thumbnailList.adContainer &&\n"
                         "            thumbnailList.adContainer.classList.contains('focus') &&\n"
                         "            thumbnailList.adReady === true) {\n"
                         "            skbParams.items = actBannerAd;\n"
                         "          }\n", "", "banner keys when focused")
    text = replace_exact(text, "      if (!fullscreenAd.isDisplaying) {\n"
                         "        exports.option.show();\n"
                         "      }\n",
                         "      exports.option.show();\n", "softkeys hidden under the fullscreen ad")
    return check_no_ads(text)


def video_thumbnails(text):
    text = replace_exact(text, ",this.bannerAdPlaceholder=null,this.bannerAd=null,this.adContainer=null,"
                         "this.adReady=!1,this.fullscreenAd=!1}", "}", "banner fields")
    text = cut(text, ",ThumbnailList.prototype.getBannerAd=function(){", "getBannerAd")
    return check_no_ads(text)


def video_css(text):
    text, n = re.subn(r"[^{}]*(banner-ad|ads-fullscreen)[^{}]*\{[^}]*\}", "", text)
    if n != 7:
        raise PatchError(f"expected the 7 ad styles, found {n}")
    return check_no_ads(text)


def recorder_locale(text, path):
    locale = path.split("/")[-1].removesuffix(".json")
    if locale not in RECORDER_L10N:
        raise PatchError(f"no Recording Quality strings for {locale} in RECORDER_L10N")
    title, names, choice = RECORDER_L10N[locale]
    strings = {"recording-rate": title}
    strings.update((f"settings-bitrate-{k}k", choice.format(name=name, kbps=k))
                   for k, name in zip(RECORDER_KBPS, names, strict=True))
    entries = json.loads(text)
    for entry in entries:
        if entry.get("$i") in strings:
            entry["$v"] = strings.pop(entry["$i"])
    entries += [{"$i": key, "$v": value} for key, value in strings.items()]
    return json.dumps(entries, ensure_ascii=False, separators=(",", ":"))


def patch_text(name, path, text, cfg):
    for p_path, rewrite in cfg.get("rewrites", []):
        if p_path == path:
            try:
                text = rewrite(text)
            except PatchError as e:
                fail(f"{name}/{path}: {e}")
    for p_path, old, new in cfg.get("patches", []):
        if p_path == path:
            if text.count(old) != 1:
                fail(f"{name}/{path}: anchor found {text.count(old)} times, expected 1:\n  {old!r}")
            text = text.replace(old, new)
    for p_path, start, end, source in cfg.get("splices", []):
        if p_path == path:
            i, j = text.find(start), text.find(end)
            if text.count(start) != 1 or j < i:
                fail(f"{name}/{path}: splice markers not found as expected")
            text = text[:i] + source.read_text(encoding="utf-8") + text[j:]
    return text


def build_overlay(name):
    cfg = OVERLAYS[name]
    base = BASE / name
    files_dir = SRC / "overlays" / name
    added = {}
    if cfg.get("extra_files", True) and files_dir.is_dir():
        added = {p.relative_to(files_dir).as_posix(): p.read_bytes()
                 for p in sorted(files_dir.rglob("*")) if p.is_file()}
    targets = {p[0] for kind in ("patches", "splices", "rewrites") for p in cfg.get(kind, [])}

    out = USERINIT / "overlays" / name
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "application.zip.tmp"
    seen = set()
    with zipfile.ZipFile(base / "application.zip") as zin, zipfile.ZipFile(tmp, "w") as zout:
        remove = set(cfg.get("remove", []))
        missing = remove - set(zin.namelist())
        if missing:
            tmp.unlink()
            fail(f"{name}: files to remove not in the base zip: {sorted(missing)}")
        for info in zin.infolist():
            if info.filename in remove:
                continue
            data = added.pop(info.filename, None)
            if data is None:
                data = zin.read(info.filename)
            if info.filename in targets:
                seen.add(info.filename)
                data = patch_text(name, info.filename, data.decode("utf-8"), cfg).encode("utf-8")
            zout.writestr(info, data, compress_type=info.compress_type)
        for path, data in added.items():
            zi = zipfile.ZipInfo(path, date_time=(2026, 1, 1, 0, 0, 0))
            zi.external_attr = 0o644 << 16
            zout.writestr(zi, data, compress_type=zipfile.ZIP_DEFLATED)
    if targets - seen:
        tmp.unlink()
        fail(f"{name}: files to patch not in the base zip: {sorted(targets - seen)}")
    tmp.replace(out / "application.zip")
    if (base / "manifest.webmanifest").exists():
        shutil.copyfile(base / "manifest.webmanifest", out / "manifest.webmanifest")
    stock = STOCK_MD5.get(name) or hashlib.md5((base / "application.zip").read_bytes()).hexdigest()
    (out / "stock.md5").write_text(stock + "\n", newline="\n")
    print(f"{name:10} -> {(out / 'application.zip').relative_to(ROOT)} "
          f"({(out / 'application.zip').stat().st_size} bytes)")


STT_MODELS = {
    "parakeet-tdt_ctc-110m-Q4_K_M.gguf": (
        "https://huggingface.co/handy-computer/parakeet-tdt_ctc-110m-gguf/resolve/"
        "766f172fe70eb66785e3371664f53762e0fbafaa/",
        "486414fd90185a8c8a4ced7c123cfb133ff4f7958426c6b8bd9049946b56b448"),
    "ggml-base-q5_1.bin": (
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/",
        "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898"),
}


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch_stt_models():
    out = USERINIT / "services" / "stt" / "models"
    out.mkdir(parents=True, exist_ok=True)
    for name, (base, sha) in STT_MODELS.items():
        path = out / name
        if path.is_file() and sha256_of(path) == sha:
            continue
        print(f"stt        downloading {name}")
        part = out / f"{name}.part"
        try:
            with urllib.request.urlopen(base + name, timeout=60) as r, open(part, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            if sha256_of(part) != sha:
                fail(f"{name}: the download doesn't match its sha256")
            part.replace(path)
        except OSError as e:
            fail(f"couldn't download {name}: {e}")
        finally:
            part.unlink(missing_ok=True)
    print(f"stt        -> {out.relative_to(ROOT)} ({len(STT_MODELS)} models)")


def build_app(name, app):
    out = USERINIT / "apps" / name
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out / "application.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(app.rglob("*")):
            if path.is_file():
                zi = zipfile.ZipInfo(path.relative_to(app).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
                zi.external_attr = 0o644 << 16
                z.writestr(zi, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    shutil.copyfile(app / "manifest.webmanifest", out / "manifest.webmanifest")
    print(f"{name:10} -> {(out / 'application.zip').relative_to(ROOT)}")


APPS = {"kaiva": SRC / "kaiva" / "app",
        "qrreader": SRC / "qrreader" / "app",
        "flipfull": SRC / "toolbox" / "app"}

TARGETS = {**{n: (lambda n=n: build_overlay(n)) for n in OVERLAYS},
           **{n: (lambda n=n: build_app(n, APPS[n])) for n in APPS},
           "stt": fetch_stt_models}


def check_features():
    ini = configparser.ConfigParser(interpolation=None)
    ini.read(USERINIT / "features.ini", encoding="utf-8")
    exists = {
        "overlays": lambda n: n in OVERLAYS,
        "apps": lambda n: n in APPS,
        "services": lambda n: (USERINIT / "services" / n / "service.sh").is_file(),
        "hosts": lambda n: (USERINIT / "etc" / "hosts.d" / f"{n}.hosts").is_file(),
        "prefs": lambda n: (USERINIT / "etc" / "prefs.d" / f"{n}.js").is_file(),
    }
    bad = []
    for fid in ini.sections():
        f = ini[fid]
        if not re.fullmatch(r"[a-z0-9-]+", fid):
            bad.append(f"[{fid}]: an id is lowercase letters, digits and dashes")
        if not f.get("title") or not f.get("about"):
            bad.append(f"[{fid}]: no title or about")
        if f.get("default") not in ("on", "off"):
            bad.append(f"[{fid}] default: on or off")
        for key, ok in exists.items():
            bad += [f"[{fid}] {key}: there's no {n}" for n in f.get(key, "").split() if not ok(n)]
        bad += [f"[{fid}] requires: no feature {n}" for n in f.get("requires", "").split() if n not in ini]
    if not ini.sections():
        bad.append("no features")
    if bad:
        fail("userinit/features.ini:\n  " + "\n  ".join(bad))


def build(names=None):
    check_features()
    for name in names or TARGETS:
        if name not in TARGETS:
            fail(f"unknown target {name}; choose from {', '.join(TARGETS)}")
        TARGETS[name]()

if __name__ == "__main__":
    build(sys.argv[1:])
