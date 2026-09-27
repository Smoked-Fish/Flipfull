





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

LIVE_SCRIPT = '    <script defer="" src="js/live_wallpaper.js"></script>\n'

OVERLAYS = {
    "launcher": {
        "patches": [
            ("dist/app.bundle.js",
             'case"ArrowLeft":break;case"ArrowDown":',
             'case"ArrowLeft":break;case"ArrowRight":O.default.launch("manifestUrl",'
             'window.AppOrigin.getManifestURL("camera"));break;case"ArrowDown":'),
            ("dist/app.bundle.js",
             'if("TF"===s.default.getBuildOperatorName()&&"kaios-voiceassistant"===e.name)return!0;',
             ''),
            ("dist/app.bundle.js",
             'if("TMO"===s.default.getBuildOperatorName()&&"kaios-voiceassistant"===e.name)return!0;',
             ''),
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
             '    <script defer="" src="js/external_screen_manager.js"></script>\n',
             '    <script defer="" src="js/external_screen_manager.js"></script>\n' + LIVE_SCRIPT),
            ("index_remote.html",
             '    <script defer="" src="remote/dist/app.bundle.js"></script>\n',
             '    <script defer="" src="remote/dist/app.bundle.js"></script>\n' + LIVE_SCRIPT),
            ("js/init_logo_handler.js",
             'CustomLogoPath.oslogo.image="tmo"===e?`${SYSTEM_RESOURCE}branding/initlogo_tmo.png`'
             ':"mpcs"===e?`${SYSTEM_RESOURCE}branding/initlogo_mpcs.png`'
             ':`${SYSTEM_RESOURCE}branding/initlogo.png`',
             'CustomLogoPath.oslogo.image=`${SYSTEM_RESOURCE}branding/initlogo.png`'),
        ],
        "rewrites": [
            ("js/account_manager/oauth2_config.js", lambda text: google_oauth(text)),
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


def build_kaiva():
    app = SRC / "kaiva" / "app"
    out = USERINIT / "apps" / "kaiva"
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out / "application.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(app.rglob("*")):
            if path.is_file():
                zi = zipfile.ZipInfo(path.relative_to(app).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
                zi.external_attr = 0o644 << 16
                z.writestr(zi, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    print(f"{'kaiva':10} -> {(out / 'application.zip').relative_to(ROOT)}")


TARGETS = {**{n: (lambda n=n: build_overlay(n)) for n in OVERLAYS}, "kaiva": build_kaiva}


def build(names=None):
    for name in names or TARGETS:
        if name not in TARGETS:
            fail(f"unknown target {name}; choose from {', '.join(TARGETS)}")
        TARGETS[name]()


if __name__ == "__main__":
    build(sys.argv[1:])
