





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
    '            <span>Call recording</span>\n'
    '          </a>\n'
    '        </li>\n\n')
ASSISTED_DIALING_ITEM = "        <li role=\"menuitem\" id='menuItem-assisted-dialing' class=\"hidden\">\n"
DISPLAY_ITEM = ('              <a id="menuItem-display" class="menu-item" href="#display" '
                'data-l10n-id="display">Display</a>\n            </li>\n')
HOME_SHORTCUTS_ITEM = ('            <li role="menuitem">\n'
                       '              <a id="menuItem-homeShortcuts" class="menu-item" '
                       'href="#home_shortcuts">Home screen shortcuts</a>\n'
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

OVERLAYS = {
    "launcher": {
        "patches": [
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
             '    <script defer="" src="js/external_screen_manager.js"></script>\n' + SYSTEM_SCRIPTS),
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
        for info in zin.infolist():
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
