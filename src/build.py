





import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
BASE = SRC / "overlays" / "base"
USERINIT = ROOT / "userinit"

GOOGLE_REDIRECT = "http://localhost/redirect/loginpages/redirect.html"

SYSTEM_SCRIPTS = ('    <script defer="" src="js/live_wallpaper.js"></script>\n'
                  '    <script defer="" src="js/flipfull_system.js"></script>\n')
MAPS_SCRIPT = '    <script defer="" src="js/flipfull_maps.js"></script>\n'

OPTIONS = {"keep_folders": False}

NO_FOLDERS = [
    ("dist/app.bundle.js",
     'X=X.concat(JSON.parse(i)||(n<=256?[]:r))',
     'localStorage.removeItem("flipfullFolders"),'
     'X=X.concat((JSON.parse(i)||(n<=256?[]:r)).filter(function(e){'
     'return"games"!==e.basisname&&"utilities"!==e.basisname}))'),
    ("dist/app.bundle.js",
     'J=256===n?["Carrier"]:["Games","Carrier","Utilities"]',
     'J=["Carrier"]'),
]
KEEP_FOLDERS = [
    ("dist/app.bundle.js",
     'X=X.concat(JSON.parse(i)||(n<=256?[]:r))',
     'X=X.concat(function(s,d){if(s&&!localStorage.getItem("flipfullFolders")){'
     'd.forEach(function(f){s.some(function(e){return e.basisname===f.basisname})||s.push(f)});'
     'localStorage.setItem("flipfullFolders","1")}return s||d}(JSON.parse(i),n<=256?[]:r))'),
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

def zip_names(app):
    with zipfile.ZipFile(BASE / app / "application.zip") as z:
        return z.namelist()


OVERLAYS = {
    "launcher": {
        "patches": [
            ("dist/app.bundle.js",
             'ee.default.getSettings().then(function(t){e.forceSettings=t,',
             'ee.default.getSettings().then(function(t){e.forceSettings=t,'
             '["home.customization.keypress","home.customization.longpress"].forEach(function(k){'
             'SettingsObserver.observe(k,null,function(v){e.forceSettings[k]=v})}),'),
            ("dist/app.bundle.js",
             'if("TF"===s.default.getBuildOperatorName()&&"kaios-voiceassistant"===e.name)return!0;',
             ''),
            ("dist/app.bundle.js",
             'if("TMO"===s.default.getBuildOperatorName()&&"kaios-voiceassistant"===e.name)return!0;',
             ''),
        ],
        "optional_patches": lambda: KEEP_FOLDERS if OPTIONS["keep_folders"] else NO_FOLDERS,
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
             '    <script defer="" src="js/external_screen_manager.js"></script>\n',
             '    <script defer="" src="js/external_screen_manager.js"></script>\n' + SYSTEM_SCRIPTS + MAPS_SCRIPT),
            ("index_remote.html",
             '    <script defer="" src="remote/dist/app.bundle.js"></script>\n',
             '    <script defer="" src="remote/dist/app.bundle.js"></script>\n' + SYSTEM_SCRIPTS),
            ("js/init_logo_handler.js",
             'CustomLogoPath.oslogo.image="tmo"===e?`${SYSTEM_RESOURCE}branding/initlogo_tmo.png`'
             ':"mpcs"===e?`${SYSTEM_RESOURCE}branding/initlogo_mpcs.png`'
             ':`${SYSTEM_RESOURCE}branding/initlogo.png`',
             'CustomLogoPath.oslogo.image=`${SYSTEM_RESOURCE}branding/initlogo.png`'),
            ("js/hardware_buttons.js",
             '.prototype.repeat=function(){this.repeating=!0,this.repeatCount++,',
             '.prototype.repeat=function(){if(!this.repeating&&window.FlipfullMedia&&'
             'window.FlipfullMedia.hold(this.direction))return void(this.repeating=!0);'
             'this.repeating=!0,this.repeatCount++,'),
            ("dist/app.bundle.js", EVENT_LOGGER_START, ''),
            ("index.html",
             '    <script defer="" src="js/fota/fotaJs_Loader.js"></script>\n',
             ''),
        ],
        "rewrites": [
            ("js/account_manager/oauth2_config.js", lambda text: google_oauth(text)),
        ],
    },
    "settings": {
        "patches": [
            ("elements/call.html", ASSISTED_DIALING_ITEM, CALL_RECORDING_ITEM + ASSISTED_DIALING_ITEM),
            ("js/panels/call/panel.js",
             "      'menuItem-assisted-dialing': '#assisted_dialing',\n",
             "      'menuItem-assisted-dialing': '#assisted_dialing',\n"
             "      'call-recording-item': '#call_recording',\n"),
            ("index.html", DISPLAY_ITEM, DISPLAY_ITEM + HOME_SHORTCUTS_ITEM),
            ("js/panels/carrier_detail/panel.js", NETWORK_TYPE_HIDING,
             "        elements.networkType.classList.remove('hidden');\n"),
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
        ] + [(m, lambda text: music_manifest(text)) for m in zip_names("music")
             if m.startswith("manifest") and m.endswith(".webmanifest")],
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


def google_oauth(text):
    found = sorted(ROOT.glob("client_secret*.json"))
    if not found:
        print("           no client_secret*.json in the repo root - stock Google client kept")
        return text
    if len(found) > 1:
        fail(f"more than one Google client JSON, keep only one: {[f.name for f in found]}")
    try:
        client = json.loads(found[0].read_text(encoding="utf-8"))
    except ValueError as e:
        fail(f"{found[0].name}: not valid JSON ({e})")
    web = client.get("web")
    if not web:
        fail(f"{found[0].name}: not a 'Web application' client; create one of that type")
    if GOOGLE_REDIRECT not in web.get("redirect_uris", []):
        fail(f"{found[0].name}: add {GOOGLE_REDIRECT} under 'Authorized redirect URIs' "
             "in the Cloud Console, then download the JSON again")
    for key in ("client_id", "client_secret"):
        if not web.get(key):
            fail(f"{found[0].name}: no {key}")
        text, n = re.subn(rf"({key}:\s*')[^']*(')", lambda m: m.group(1) + web[key] + m.group(2), text)
        if n != 1:
            fail(f"oauth2_config.js: {key} found {n} times, expected 1")
    print(f"           Google client from {found[0].name}: {web['client_id']}")
    return text


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
        fail(f"music: {what}: found {text.count(start)} times, expected 1")
    i = text.index(start)
    j = js_group_end(text, i + len(start) - 1)
    if then:
        if not text.startswith(then, j):
            fail(f"music: {what}: expected {then!r} after it")
        j += len(then)
    return text[:i] + text[j:]


def replace_exact(text, old, new, what, count=1):
    if text.count(old) != count:
        fail(f"music: {what}: found {text.count(old)} times, expected {count}")
    return text.replace(old, new)


def check_no_ads(text, path):
    left = [w for w in ("getKaiAd", "BannerAd", "RadioAd", "banner-ad", "FullscreenAd", "kaiads",
                        "BANNER_AD", "RADIO_AD", "musicBannerAd", "radioBannerAd", "ads-sdk")
            if w in text]
    if left:
        fail(f"music: {path} still mentions {', '.join(left)}")
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
    return check_no_ads(text, "js/bind.js")


def music_app(text):
    text = replace_exact(text, "    let isShowFullscreenAds = false;\n", "", "fullscreen ad flag")
    text = replace_exact(text, "            if (!isShowFullscreenAds) {\n"
                         "                showFullscreenAd();\n"
                         "            }\n", "", "fullscreen ad on return")
    text = replace_exact(text, "typeof getKaiAd === 'function' && e.key !== 'EndCall'",
                         "e.key !== 'EndCall'", "full version (overlay back key)")
    start = "        if (typeof getKaiAd !== 'function' && document.hidden"
    if text.count(start) != 1:
        fail("music: js/music.js: list-only version block changed")
    i = text.index(start)
    cond_end = js_group_end(text, text.index("(", i))
    block = text.index("{", cond_end)
    if text[cond_end:block].strip():
        fail("music: js/music.js: list-only version block changed")
    end = js_group_end(text, block)
    text = text[:i] + text[end:].lstrip(" ").lstrip("\n")
    return check_no_ads(text, "js/music.js")


def music_index(text):
    text = replace_exact(text, '    <script src="js/ads/kaiads.v5.min.js"></script>\n', "", "SDK loader")
    for f in ("js/ui/banner_ad.js", "js/icecast/radio_ad.js"):
        text = replace_exact(text, f'    <!-- <script defer type="text/javascript" data-src="{f}"></script> -->\n',
                             "", f)
    for prefix in ("", "i-"):
        start = f'            <div id="{prefix}banner-ad-placeholder">'
        end = f'<div id="{prefix}banner-ad-container" tabindex="-1"></div>\n'
        if text.count(start) != 1 or text.count(end) != 1:
            fail(f"music: {prefix}banner placeholder markup changed")
        text = text[:text.index(start)] + text[text.index(end) + len(end):]
    return check_no_ads(text, "index.html")


def music_css(text):
    import re
    text, n = re.subn(r"[^{}]*banner-ad[^{}]*\{[^}]*\}", "", text)
    if n < 3:
        fail(f"music: expected the banner styles in style/main.css, found {n} rules")
    return check_no_ads(text, "style/main.css")


def music_manifest(text):
    text = replace_exact(text, ',"dependencies":{"ads-sdk":"1.4.5"}', "", "ads-sdk dependency")
    return check_no_ads(text, "manifest.webmanifest")


def patch_text(name, path, text, cfg):
    for p_path, rewrite in cfg.get("rewrites", []):
        if p_path == path:
            text = rewrite(text)
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
    cfg = dict(OVERLAYS[name])
    if "optional_patches" in cfg:
        cfg["patches"] = cfg.get("patches", []) + cfg["optional_patches"]()
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
    print(f"{name:10} -> {(out / 'application.zip').relative_to(ROOT)} "
          f"({(out / 'application.zip').stat().st_size} bytes)")


def build_app(name, app):
    out = USERINIT / "apps" / name
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out / "application.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(app.rglob("*")):
            if path.is_file():
                zi = zipfile.ZipInfo(path.relative_to(app).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
                zi.external_attr = 0o644 << 16
                z.writestr(zi, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    print(f"{name:10} -> {(out / 'application.zip').relative_to(ROOT)}")


TARGETS = {**{n: (lambda n=n: build_overlay(n)) for n in OVERLAYS},
           "kaiva": lambda: build_app("kaiva", SRC / "kaiva" / "app"),
           "qrreader": lambda: build_app("qrreader", SRC / "qrreader" / "app")}


def build(names=None, keep_folders=False):
    OPTIONS["keep_folders"] = keep_folders
    for name in names or TARGETS:
        if name not in TARGETS:
            fail(f"unknown target {name}; choose from {', '.join(TARGETS)}")
        TARGETS[name]()

if __name__ == "__main__":
    args = sys.argv[1:]
    keep = "--keep-folders" in args
    build([a for a in args if a != "--keep-folders"], keep_folders=keep)
