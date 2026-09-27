"""One place to build, install, inspect and remove everything custom on the phone.

    python flip4.py build [target ...]   rebuild overlays + apps into userinit/
    python flip4.py install [--reboot]   put userinit/ on the phone (builds first)
                  [--keep-folders]       ... keeping the launcher's Games / Utilities folders
    python flip4.py status               what is installed and running
    python flip4.py restart [app ...]    restart the UI (b2g), or just those apps
    python flip4.py removable [...]      pick which preloaded apps can be uninstalled
    python flip4.py backup [DIR]         copy contacts, messages, settings, app data to the PC
    python flip4.py restore DIR          put a backup back on the phone
    python flip4.py cleanup [--yes]      delete files left by the old layouts
    python flip4.py uninstall [--reboot] remove everything; the phone boots stock
"""
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCAL = ROOT / "userinit"
UI = "/data/local/userinit"
MANIFEST = f"{UI}/.installed-files"
HOOK_RC = "/vendor/etc/init/init.userinit.rc"
APPS_SOCK = "/data/local/tmp/apps-uds.sock"
KAIVA_URL = "http://kaios-voiceassistant.localhost/manifest.webmanifest"
QR_URL = "http://qrreader.localhost/manifest.webmanifest"
APPS_DB = "/data/local/webapps/db/apps.sqlite"
REMOVABLE_LIST = f"{UI}/removable-apps"
CORE_APPS = {
    "system": "the whole phone UI", "shared": "code every app uses", "launcher": "home screen",
    "keyboard": "typing", "settings": "Settings", "callscreen": "phone calls",
    "emergency-call": "emergency calls", "network-alerts": "emergency alerts",
    "ftu": "first-run setup", "customization": "carrier setup", "loginpages": "account sign-in",
    "stk": "SIM menus", "wappush": "carrier messages", "wallpaper": "wallpaper picker",
    "ringtones": "ringtone picker",
}
BACKUP_PATHS = ["data/local/service/api-daemon", "data/local/webapps", "data/b2g/mozilla"]
BACKUP_EXCLUDES = ["*/startupCache", "*/shader-cache", "*/safebrowsing", "*/cache2",
                   "data/local/webapps/downloading"]
MEDIA_PATHS = {"internal": "/data/media", "sdcard": "/mnt/sdcard"}
REPLACED_APPS = {"Dictate": "http://dictate.localhost/manifest.webmanifest"}
FWD_PORT = 6123
TEXT_SUFFIXES = {".sh", ".js", ".md", ".conf", ".rc"}
TEXT_NAMES = {"hosts"}
RUNTIME = ("run.log", "run.log.old", "busybox-path.sh", "bin/bbx/", "uninstall", ".overlays-mounted",
           "disable", "services/stt/server.log", "services/stt/server.log.old",
           "services/stt/stt.conf", "services/callrec/callrecd.log", "services/callrec/callrecd.log.old",
           "services/callrec/callrec.conf", "removable-apps")


def find_adb():
    if os.environ.get("ADB"):
        return os.environ["ADB"]
    if shutil.which("adb"):
        return shutil.which("adb")
    exe = "adb.exe" if os.name == "nt" else "adb"
    for d in (ROOT / "platform-tools", ROOT.parent / "platform-tools"):
        if (d / exe).exists():
            return str(d / exe)
    sys.exit("adb not found: set ADB=/path/to/adb or put platform-tools next to this repo")


ADB = None


def adb(*args, check=True):
    r = subprocess.run([ADB, *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit(f"adb {' '.join(args)} failed:\n{r.stdout}{r.stderr}")
    return r.stdout.strip()


def sh(cmd, check=True):
    return adb("shell", cmd, check=check)


def require_root():
    if sh("id -u", check=False) != "0":
        sys.exit("adbd is not running as root (run: adb root)")


def apps_cmd(cmd, param=None):
    adb("forward", f"tcp:{FWD_PORT}", f"localfilesystem:{APPS_SOCK}")
    try:
        with socket.create_connection(("127.0.0.1", FWD_PORT), timeout=60) as s:
            msg = {"cmd": cmd} if param is None else {"cmd": cmd, "param": param}
            s.sendall((json.dumps(msg) + "\n").encode())
            buf = b""
            while b"\n" not in buf:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
    finally:
        adb("forward", "--remove", f"tcp:{FWD_PORT}", check=False)
    return json.loads(buf) if buf.strip() else {}


def apps_ok(r):
    return isinstance(r, dict) and "success" in r


def installed_apps():
    return str(apps_cmd("list").get("success") or "")


def install_package(name):
    tmp_zip = f"/data/local/tmp/userinit-{name}.zip"
    sh(f"cp {UI}/apps/{name}/application.zip {tmp_zip} && chmod 0644 {tmp_zip}")
    r = apps_cmd("install", tmp_zip)
    sh(f"rm -f {tmp_zip}", check=False)
    return r

def install_app_zip(zip_path):
    zip_path = Path(zip_path)

    if not zip_path.is_file():
        sys.exit(f"application package not found: {zip_path}")

    if zip_path.suffix.lower() != ".zip":
        sys.exit(f"application package must be a .zip file: {zip_path}")

    remote = f"/data/local/tmp/flip4-{zip_path.name}"

    print(f"pushing {zip_path} ...")
    adb("push", str(zip_path), remote)

    try:
        sh(f"chmod 0644 '{remote}'")
        r = apps_cmd("install", remote)

        if not apps_ok(r):
            print(f"app install failed: {r}")
            sys.exit(1)

        print(f"app installed: {zip_path.name}")
    finally:
        sh(f"rm -f '{remote}'", check=False)


def install_qrreader():
    fresh = QR_URL not in installed_apps()
    r = install_package("qrreader")
    if not apps_ok(r):
        print(f"QR Reader: install failed: {r}")
    else:
        print("QR Reader:", "installed" if fresh else "updated")


def install_kaiva():
    apps = installed_apps()
    replaced = [name for name, url in REPLACED_APPS.items() if url in apps]
    for name in replaced:
        r = apps_cmd("uninstall", REPLACED_APPS[name])
        print(f"{name}:", "uninstalled, KaiVA replaces it" if apps_ok(r) else f"not uninstalled ({r})")
    if replaced and KAIVA_URL in apps:
        apps_cmd("uninstall", KAIVA_URL)
    fresh = KAIVA_URL not in installed_apps()

    r = install_package("kaiva")
    if not apps_ok(r):
        print(f"KaiVA: install failed: {r}")
    elif fresh:
        print("KaiVA: installed; it is now the keyboard's voice input and the assistant")
    elif replaced:
        print("KaiVA: updated. Open Voice Assistant once so the keyboard's voice input "
              "points at it again")
    else:
        print("KaiVA: updated")


def local_files():
    return sorted(p.relative_to(LOCAL).as_posix() for p in LOCAL.rglob("*")
                  if p.is_file() and p.name != ".gitkeep")


def check_line_endings(files):
    bad = [f for f in files
           if (Path(f).suffix in TEXT_SUFFIXES or Path(f).name in TEXT_NAMES)
           and b"\r\n" in (LOCAL / f).read_bytes()]
    if bad:
        sys.exit("these files have Windows (CRLF) line endings; the repo's .gitattributes should "
                 "prevent that - re-checkout with `git add --renormalize .`:\n  " + "\n  ".join(bad))


def push_changed(files):

    out = sh(f"cd {UI} 2>/dev/null && md5sum " + " ".join(f"'{f}'" for f in files) + " 2>/dev/null",
             check=False)
    on_phone = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2:
            on_phone[parts[1]] = parts[0]
    changed = [f for f in files
               if on_phone.get(f) != hashlib.md5((LOCAL / f).read_bytes()).hexdigest()]
    staging = f"{UI}/.staging"
    sh(f"rm -rf {staging}")
    for f in changed:
        adb("push", str(LOCAL / f), f"{staging}/{f}")
    if changed:
        sh(f"cd {UI} && for f in " + " ".join(f"'{f}'" for f in changed) +
           f"; do mkdir -p \"$(dirname \"$f\")\" && mv -f \"{staging}/$f\" \"$f\"; done; rm -rf {staging}")
    return changed


def version():
    try:
        return subprocess.run(["git", "-C", str(ROOT), "describe", "--always", "--dirty"],
                              capture_output=True, text=True).stdout.strip() or "unknown"
    except OSError:
        return "unknown"


def cmd_build(args):
    sys.path.insert(0, str(ROOT / "src"))
    import build
    build.build(args.targets, keep_folders=getattr(args, "keep_folders", False))


def cmd_install(args):
    if args.keep_folders and args.no_build:
        sys.exit("--keep-folders changes how the launcher overlay is built; drop --no-build")
    require_root()
    if sh(f"ls {HOOK_RC}", check=False) != HOOK_RC:
        print(f"WARNING: {HOOK_RC} is missing - nothing in userinit will run at boot "
              "until the boot hook is flashed (src/boot-hook/README.md)")
    if not args.no_build:
        cmd_build(argparse.Namespace(targets=[], keep_folders=args.keep_folders))

    files = local_files()
    check_line_endings(files)
    old = [l for l in sh(f"cat {MANIFEST} 2>/dev/null", check=False).splitlines()
           if l and not l.startswith("#")]

    sh(f"rm -f {UI}/uninstall")
    sh(f"mkdir -p {UI}")
    changed = push_changed(files)
    print(f"userinit/: {len(changed)} of {len(files)} files changed and pushed")

    stale = sorted(set(old) - set(files) - set(RUNTIME))
    if stale:
        sh("rm -f " + " ".join(f"'{UI}/{f}'" for f in stale))
        print("removed files no longer in the repo:", ", ".join(stale))
    manifest = f"# Flipfull {version()} installed {time.strftime('%Y-%m-%d %H:%M')}\n" + \
               "\n".join(files) + "\n"
    tmp = ROOT / ".installed-files.tmp"
    tmp.write_text(manifest, newline="\n")
    try:
        adb("push", str(tmp), MANIFEST)
    finally:
        tmp.unlink()

    sh(f"chown -R root:root {UI}; "
       f"find {UI} -type d -exec chmod 0711 {{}} \\; ; "
       f"find {UI} -type f -exec chmod 0644 {{}} \\; ; "
       f"find {UI} -type f \\( -name '*.sh' -o -path '*/bin/*' -o -name stt-server -o -name ttlfix \\) "
       f"-exec chmod 0755 {{}} \\;")

    print(sh(f"sh {UI}/tools/cleanup-old.sh --userinit-only", check=False))

    install_kaiva()
    install_qrreader()

    print(sh(f"sh {UI}/boot-completed.d/50-services.sh", check=False))
    print("Overlays and Gecko prefs apply at the next boot.")
    finish(args, "installed")

def cmd_install_app(args):
    require_root()
    install_app_zip(args.application)


def cmd_status(args):
    require_root()
    print(sh(f"head -1 {MANIFEST} 2>/dev/null || echo 'userinit: not installed by flip4.py'", check=False))
    hook = sh(f"ls {HOOK_RC} 2>/dev/null", check=False)
    print("boot hook:", "present" if hook else "MISSING")
    if sh(f"ls {UI}/uninstall 2>/dev/null", check=False):
        print("uninstall pending: the next boot removes everything")
    print("\noverlays and boot media mounted:")
    print(sh("awk '$4 ~ /userinit\\/(overlays|media)/ {print \"  \" $5 \"  <-  \" $4}' /proc/self/mountinfo",
             check=False) or "  none")
    print("\nservices:")
    print(sh(f"for s in {UI}/services/*/service.sh; do sh $s status; done", check=False))
    print("\napps:")
    try:
        apps = installed_apps()
        print("  KaiVA:", "installed" if KAIVA_URL in apps else "not installed")
        print("  QR Reader:", "installed" if QR_URL in apps else "not installed")
        for name, url in REPLACED_APPS.items():
            if url in apps:
                print(f"  {name}: still installed (flip4.py install replaces it)")
    except OSError as e:
        print(f"  app list unavailable ({e})")
    removable = [name for name, on in preloaded_apps(quiet=True) if on]
    print("  preloaded apps you can uninstall:", ", ".join(removable) if removable else "none")
    print("\nupdaters (stopped after boot, 10-no-updates.sh):")
    print(sh("for s in update_engine updater-daemon; do echo \"  $s: $(getprop init.svc.$s)\"; done",
             check=False))
    print("\nGecko prefs block:", "present" if sh(
        "grep -l '^// >>> userinit' /data/b2g/mozilla/*.default/user.js 2>/dev/null",
        check=False) else "not written yet (next boot)")
    print("\nlast boot (run.log):")
    print(sh(f"tail -15 {UI}/run.log 2>/dev/null", check=False))


def cmd_restart(args):
    require_root()
    script = f"{UI}/tools/restart.sh"
    if not sh(f"ls {script} 2>/dev/null", check=False):
        sys.exit("the phone's userinit is older than this command - run `flip4.py install` first")
    r = subprocess.run([ADB, "shell", f"sh {script} " + " ".join(f"'{a}'" for a in args.apps)],
                       capture_output=True, text=True)
    print((r.stdout + r.stderr).strip())
    sys.exit(r.returncode)


def cmd_cleanup(args):
    require_root()
    script = f"{UI}/tools/cleanup-old.sh"
    if not sh(f"ls {script} 2>/dev/null", check=False):
        adb("push", str(LOCAL / "tools" / "cleanup-old.sh"), "/data/local/tmp/cleanup-old.sh")
        script = "/data/local/tmp/cleanup-old.sh"
    out = sh(f"sh {script} --dry-run", check=False)
    print(out)
    if "would remove" not in out:
        return
    if not args.yes and input("\nDelete these? [y/N] ").strip().lower() != "y":
        print("nothing deleted")
        return
    print(sh(f"sh {script}", check=False))
    if script.startswith("/data/local/tmp"):
        sh(f"rm -f {script}", check=False)


def cmd_uninstall(args):
    require_root()
    print(sh(f"for s in {UI}/services/*/service.sh; do [ -f $s ] && sh $s stop; done", check=False))
    apps = installed_apps()
    for name, url in {"KaiVA": KAIVA_URL, "QR Reader": QR_URL, **REPLACED_APPS}.items():
        if url in apps:
            r = apps_cmd("uninstall", url)
            print(f"{name}:", "uninstalled" if apps_ok(r) else f"not uninstalled ({r})")
    push_changed(["run.sh"])
    sh(f"chmod 0755 {UI}/run.sh; touch {UI}/uninstall")
    print("Everything else is removed at the next boot (preloaded apps you made removable "
          "go back to stock); the phone then boots stock.")
    print("(Changed your mind before rebooting? `flip4.py install` cancels it.)")
    finish(args, "uninstall scheduled")


def preloaded_apps(quiet=False):
    out = sh(f"{UI}/bin/sqlite3 -init /dev/null -separator '|' {APPS_DB} "
             "'SELECT name, removable FROM apps WHERE preloaded = 1 ORDER BY name'", check=False)
    apps = []
    for line in out.splitlines():
        name, _, flag = line.partition("|")
        if name and flag in ("0", "1"):
            apps.append((name, flag == "1"))
    if not apps and not quiet:
        sys.exit(f"couldn't read {APPS_DB} with {UI}/bin/sqlite3 - run `flip4.py install` first")
    return apps


def parse_picks(answer, count):
    picks = set()
    for part in answer.replace(",", " ").split():
        lo, _, hi = part.partition("-")
        if not lo.isdigit() or (hi and not hi.isdigit()):
            return None
        a, b = int(lo), int(hi or lo)
        if not (1 <= a <= b <= count):
            return None
        picks.update(range(a, b + 1))
    return picks


def pick_removable(apps, chosen):
    names = [name for name, _ in apps]
    while True:
        print("\nPreloaded apps ([x] = can be uninstalled from the app list):")
        for i, name in enumerate(names, 1):
            core = f"  (core: {CORE_APPS[name]})" if name in CORE_APPS else ""
            print(f"  {i:3} [{'x' if name in chosen else ' '}] {name}{core}")
        answer = input("\nToggle numbers (e.g. 3 7-9), a = all but core, n = none, "
                       "Enter = save, q = quit: ").strip().lower()
        if answer == "":
            return chosen
        if answer == "q":
            return None
        if answer == "a":
            chosen = {n for n in names if n not in CORE_APPS}
            continue
        if answer == "n":
            chosen = set()
            continue
        picks = parse_picks(answer, len(names))
        if picks is None:
            print("  ? numbers or ranges from the list, please")
            continue
        for i in picks:
            name = names[i - 1]
            if name in chosen:
                chosen.discard(name)
            elif name in CORE_APPS and input(
                    f"  {name} is {CORE_APPS[name]}; without it the phone may not work. "
                    "Make it removable anyway? [y/N] ").strip().lower() != "y":
                continue
            else:
                chosen.add(name)


def cmd_removable(args):
    require_root()
    if not sh(f"ls {UI}/post-fs-data.d/02-removable-apps.sh 2>/dev/null", check=False):
        sys.exit("the phone's userinit is older than this command - run `flip4.py install` first")
    apps = preloaded_apps()
    names = {name for name, _ in apps}
    saved = sh(f"[ -f {REMOVABLE_LIST} ] && echo list && cat {REMOVABLE_LIST}", check=False).split()
    now = ({n for n in saved[1:] if n in names} if saved[:1] == ["list"]
           else {name for name, on in apps if on})
    if args.list:
        for name, on in apps:
            pending = "" if (name in now) == on else " (from the next boot)"
            print(f"{'x' if name in now else ' '} {name}{pending}")
        return
    apps = [(name, name in now) for name, _ in apps]
    unknown = sorted(set(args.add + args.remove) - names)
    if unknown:
        sys.exit(f"not preloaded apps: {', '.join(unknown)} (see `flip4.py removable --list`)")
    if args.all:
        chosen = {n for n in names if n not in CORE_APPS} | (now & set(CORE_APPS))
    elif args.none:
        chosen = set()
    elif args.add or args.remove:
        chosen = (now | set(args.add)) - set(args.remove)
    else:
        chosen = pick_removable(apps, set(now))
        if chosen is None:
            print("nothing changed")
            return
    gained, lost = sorted(chosen - now), sorted(now - chosen)
    if not gained and not lost:
        print("nothing to change")
        return
    tmp = ROOT / ".removable-apps.tmp"
    tmp.write_text("".join(f"{n}\n" for n in sorted(chosen)), newline="\n")
    try:
        adb("push", str(tmp), REMOVABLE_LIST)
    finally:
        tmp.unlink()
    if gained:
        print("can be uninstalled after the reboot:", ", ".join(gained))
        print("Uninstall them from the app list (Options > Uninstall). An update to the phone's "
              "software may bring an uninstalled app back.")
    if lost:
        print("can't be uninstalled any more:", ", ".join(lost))
    finish(args, "saved")


def phone_build():
    return sh("getprop ro.build.fingerprint", check=False)


def stop_ui_command(inner):
    return f"stop b2g; stop api-daemon; sleep 1; {inner}; rc=$?; start api-daemon; start b2g; exit $rc"


def cmd_backup(args):
    require_root()
    dest = Path(args.dir) if args.dir else ROOT / "backups" / time.strftime("%Y%m%d-%H%M%S")
    if dest.exists() and any(dest.iterdir()):
        sys.exit(f"{dest} is not empty")
    dest.mkdir(parents=True, exist_ok=True)
    paths = [p for p in BACKUP_PATHS if sh(f"[ -d /{p} ] && echo y", check=False) == "y"]
    tmp = "/data/local/tmp/flipfull-backup.tar.gz"
    excludes = " ".join(f"--exclude='{e}'" for e in BACKUP_EXCLUDES)
    tar = f"tar -czf {tmp} -C / {excludes} {' '.join(paths)}"
    if args.live:
        print("copying while the phone runs (databases may be caught mid-write)...")
    else:
        print("copying with the phone's UI stopped for a consistent copy; it restarts in a moment...")
        tar = stop_ui_command(tar)
    r = subprocess.run([ADB, "shell", tar], capture_output=True, text=True)
    if r.returncode != 0 or not sh(f"[ -s {tmp} ] && echo y", check=False):
        sh(f"rm -f {tmp}", check=False)
        sys.exit(f"backup failed on the phone:\n{r.stdout}{r.stderr}")
    adb("pull", tmp, str(dest / "data.tar.gz"))
    sh(f"rm -f {tmp}", check=False)
    info = {"created": time.strftime("%Y-%m-%d %H:%M:%S"), "build": phone_build(),
            "flipfull": version(), "paths": paths, "media": []}
    if args.media:
        for name, path in MEDIA_PATHS.items():
            if sh(f"[ -d {path} ] && echo y", check=False) != "y":
                continue
            print(f"media: {path} ...")
            (dest / "media").mkdir(exist_ok=True)
            adb("pull", sh(f"readlink -f {path}") + "/", str(dest / "media" / name))
            info["media"].append(name)
    (dest / "backup.json").write_text(json.dumps(info, indent=2) + "\n")
    size = sum(f.stat().st_size for f in dest.rglob("*") if f.is_file())
    print(f"backup in {dest} ({size / 1e6:.1f} MB)")


def cmd_restore(args):
    require_root()
    src = Path(args.dir)
    try:
        info = json.loads((src / "backup.json").read_text())
    except (OSError, ValueError) as e:
        sys.exit(f"{src}: not a flip4.py backup ({e})")
    tarball = src / "data.tar.gz"
    if not tarball.is_file():
        sys.exit(f"{tarball} is missing")
    if info.get("build") != phone_build():
        print(f"WARNING: the backup is from another software version:\n  backup: {info.get('build')}\n"
              f"  phone:  {phone_build()}")
        if not args.force:
            sys.exit("restore it anyway with --force")
    paths = [p for p in info.get("paths", []) if p in BACKUP_PATHS]
    print(f"This replaces the phone's {', '.join('/' + p for p in paths)}\n"
          f"(contacts, messages, call log, settings, installed apps and app data) with the "
          f"backup from {info.get('created')}. The phone reboots afterwards.")
    if not args.yes and input("Continue? [y/N] ").strip().lower() != "y":
        print("nothing changed")
        return
    if args.media:
        for name in info.get("media", []):
            local = src / "media" / name
            path = MEDIA_PATHS.get(name)
            if not local.is_dir() or not path:
                continue
            if sh(f"[ -d {path} ] && echo y", check=False) != "y":
                print(f"media: {path} isn't there (no SD card?) - {local} not restored")
                continue
            print(f"media: {local} -> {path} ...")
            path = sh(f"readlink -f {path}")
            for item in sorted(local.iterdir()):
                adb("push", str(item), f"{path}/")
            sh(f"chown -R $(stat -c %u:%g {path}) {path}; restorecon -R {path}", check=False)
    tmp = "/data/local/tmp/flipfull-restore.tar.gz"
    adb("push", str(tarball), tmp)
    dirs = " ".join(f"/{p}" for p in paths)
    done = "flipfull-restored"
    script = (f"stop b2g; stop api-daemon; sleep 1; set -- {dirs}; "
              "for d; do rm -rf $d.flipfull-old; [ -e $d ] && mv $d $d.flipfull-old; done; "
              f"if tar -xzpf {tmp} -C / && restorecon -R \"$@\"; then "
              f"for d; do rm -rf $d.flipfull-old; done; echo {done}; "
              "else for d; do rm -rf $d; [ -e $d.flipfull-old ] && mv $d.flipfull-old $d; done; fi; "
              f"rm -f {tmp}")
    r = subprocess.run([ADB, "shell", script], capture_output=True, text=True)
    if done not in r.stdout:
        print(f"restore failed; the phone's data is as it was:\n{r.stdout}{r.stderr}\n"
              "starting the UI again...")
        sh("start api-daemon; start b2g", check=False)
        sys.exit(1)
    adb("reboot", check=False)
    print("restored; the phone is rebooting")


def finish(args, what):
    if getattr(args, "reboot", False):
        adb("reboot")
        print(f"{what}; rebooting")
    else:
        print(f"{what}; reboot to apply (adb reboot)")


def main():
    global ADB
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="rebuild overlays and the KaiVA app into userinit/")
    b.add_argument("targets", nargs="*")
    i = sub.add_parser("install", help="install / update everything on the phone")
    i.add_argument("--no-build", action="store_true", help="push userinit/ as it is")
    i.add_argument("--keep-folders", action="store_true",
                   help="the launcher keeps its Games and Utilities folders")
    i.add_argument("--reboot", action="store_true")
    sub.add_parser("status", help="show what is installed and running")
    rt = sub.add_parser("restart", help="restart the phone's UI (b2g) without a reboot, "
                        "or only the named apps (launcher, settings, ...)")
    rt.add_argument("apps", nargs="*", metavar="APP")
    ia = sub.add_parser("install-app", help="install a local application.zip on the phone")
    ia.add_argument("application", metavar="application.zip",
                    help="path to the application.zip on the PC")
    r = sub.add_parser("removable", help="choose which preloaded apps can be uninstalled "
                       "(interactive without options)")
    g = r.add_mutually_exclusive_group()
    g.add_argument("--all", action="store_true", help="every preloaded app except the core ones")
    g.add_argument("--none", action="store_true", help="none (as the phone came)")
    g.add_argument("--list", action="store_true", help="show which are removable now")
    r.add_argument("--add", nargs="+", default=[], metavar="APP")
    r.add_argument("--remove", nargs="+", default=[], metavar="APP")
    r.add_argument("--reboot", action="store_true")
    bk = sub.add_parser("backup", help="copy the phone's data to the PC (default backups/<date>)")
    bk.add_argument("dir", nargs="?")
    bk.add_argument("--media", action="store_true", help="also photos, music, recordings (both storages)")
    bk.add_argument("--live", action="store_true", help="don't stop the UI while copying")
    rs = sub.add_parser("restore", help="put a backup back (replaces the phone's data, reboots)")
    rs.add_argument("dir")
    rs.add_argument("--media", action="store_true", help="also copy the backed-up media back")
    rs.add_argument("--yes", action="store_true", help="don't ask")
    rs.add_argument("--force", action="store_true", help="even onto another software version")
    c = sub.add_parser("cleanup", help="delete files left by the old layouts")
    c.add_argument("--yes", action="store_true", help="don't ask")
    u = sub.add_parser("uninstall", help="remove everything (completes at the next boot)")
    u.add_argument("--reboot", action="store_true")
    args = p.parse_args()

    if args.cmd != "build":
        ADB = find_adb()
    {"build": cmd_build, "install": cmd_install, "install-app": cmd_install_app,
    "status": cmd_status, "restart": cmd_restart, "removable": cmd_removable,
    "backup": cmd_backup, "restore": cmd_restore, "cleanup": cmd_cleanup,
    "uninstall": cmd_uninstall}[args.cmd](args)


if __name__ == "__main__":
    main()
