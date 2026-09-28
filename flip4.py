"""Build Flipfull and manage it on the phone from the PC.

    python flip4.py build [target ...]   rebuild overlays + apps into userinit/
    python flip4.py install [--reboot]   put userinit/ on the phone (builds first)
    python flip4.py release [DIR]        a zip anyone with a rooted phone can install
    python flip4.py features             the features, and which are on
    python flip4.py on ID... [--reboot]  turn features on (off: the same)
    python flip4.py status               what is installed, mounted and running
    python flip4.py restart [app ...]    restart the UI (b2g), or just those apps
    python flip4.py mon NAME...          memory and CPU of processes, every second
    python flip4.py removable [...]      pick which preloaded apps can be uninstalled
    python flip4.py google-client [FILE] use your own Google sign-in client
    python flip4.py install-app ZIP      install a local application.zip as an app
    python flip4.py backup [DIR]         copy contacts, messages, settings, app data to the PC
    python flip4.py restore DIR          put a backup back on the phone
    python flip4.py cleanup [--yes]      delete files left by the old layouts
    python flip4.py uninstall [--reboot] remove everything; the phone boots stock
"""
import argparse
import configparser
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCAL = ROOT / "userinit"
UI = "/data/local/userinit"
FLIPFULL = f"{UI}/flipfull"
STAGING = f"{UI}/.staging"
BACKUP_PATHS = ["data/local/service/api-daemon", "data/local/webapps", "data/b2g/mozilla"]
BACKUP_EXCLUDES = ["*/startupCache", "*/shader-cache", "*/safebrowsing", "*/cache2",
                   "data/local/webapps/downloading"]
MEDIA_PATHS = {"internal": "/data/media", "sdcard": "/mnt/sdcard"}
TEXT_SUFFIXES = {".sh", ".js", ".md", ".conf", ".rc", ".ini", ".awk", ".hosts"}
TEXT_NAMES = {"flipfull", "api"}


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


def sh_live(cmd):
    return subprocess.run([ADB, "shell", cmd]).returncode


def require_root():
    if sh("id -u", check=False) != "0":
        sys.exit("adbd is not running as root (run: adb root)")


def require_flipfull():
    require_root()
    if sh(f"[ -f {FLIPFULL} ] && echo y", check=False) != "y":
        sys.exit("Flipfull isn't on the phone, or is from before features.ini - run `flip4.py install` first")


def flipfull(*words, live=False):
    cmd = f"sh {FLIPFULL} " + " ".join(words)
    if live:
        return sh_live(cmd)
    return subprocess.run([ADB, "shell", cmd], capture_output=True, text=True).stdout


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


def version():
    try:
        return subprocess.run(["git", "-C", str(ROOT), "describe", "--always", "--dirty"],
                              capture_output=True, text=True).stdout.strip() or "unknown"
    except OSError:
        return "unknown"


def files_list(files):
    return (f"# Flipfull {version()} built {time.strftime('%Y-%m-%d %H:%M')}\n"
            + "\n".join(files) + "\n")


def google_client_file():
    found = sorted(ROOT.glob("client_secret*.json"))
    if len(found) > 1:
        sys.exit(f"more than one Google client JSON in the repo root, keep only one: {[f.name for f in found]}")
    return found[0] if found else None


def cmd_build(args):
    sys.path.insert(0, str(ROOT / "src"))
    import build
    build.build(args.targets)


def cmd_install(args):
    require_root()
    if not args.no_build:
        cmd_build(argparse.Namespace(targets=[]))
    files = local_files()
    check_line_endings(files)

    out = sh(f"cd {UI} 2>/dev/null && md5sum " + " ".join(f"'{f}'" for f in files) + " 2>/dev/null",
             check=False)
    on_phone = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2:
            on_phone[parts[1]] = parts[0]
    changed = [f for f in files
               if on_phone.get(f) != hashlib.md5((LOCAL / f).read_bytes()).hexdigest()
               or f in ("flipfull", "lib/common.sh", "lib/plan.awk")]
    sh(f"rm -rf {STAGING} && mkdir -p {STAGING}")
    for f in changed:
        adb("push", str(LOCAL / f), f"{STAGING}/{f}")
    tmp = ROOT / ".files.tmp"
    tmp.write_text(files_list(files), newline="\n")
    try:
        adb("push", str(tmp), f"{STAGING}/.files")
    finally:
        tmp.unlink()
    rc = sh_live(f"sh {STAGING}/flipfull setup --from {STAGING}")
    sh(f"rm -rf {STAGING}", check=False)
    if rc != 0:
        sys.exit("setup failed on the phone")

    client = google_client_file()
    if client:
        import_google_client(client)
    finish(args, "installed")


def cmd_release(args):
    if not args.no_build:
        cmd_build(argparse.Namespace(targets=[]))
    files = local_files()
    check_line_endings(files)
    name = f"flipfull-{version()}"
    dest = Path(args.dir) if args.dir else ROOT / "dist"
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / f"{name}.zip"
    release = ROOT / "src" / "release"

    def add(z, path, arcname, mode=0o644):
        zi = zipfile.ZipInfo(f"{name}/{arcname}", date_time=time.localtime()[:6])
        zi.external_attr = mode << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(zi, path.read_bytes() if isinstance(path, Path) else path)

    with zipfile.ZipFile(out, "w") as z:
        for f in files:
            add(z, LOCAL / f, f"flipfull/{f}")
        add(z, files_list(files).encode(), "flipfull/.files")
        add(z, release / "install.sh", "install.sh", 0o755)
        add(z, release / "install.bat", "install.bat")
        add(z, release / "README.txt", "README.txt")
    print(f"{out} ({out.stat().st_size / 1e6:.1f} MB): unzip it, then run install.bat (Windows) "
          "or install.sh with the phone connected")


def cmd_features(args):
    require_flipfull()
    ini = configparser.ConfigParser(interpolation=None)
    ini.read_string(flipfull("features"))
    rows = {}
    reboot = False
    for line in flipfull("state").splitlines():
        f = line.split("\t")
        if f[0] == "feature" and len(f) >= 7:
            rows[f[1]] = f
        elif f[0] == "reboot":
            reboot = f[1] == "yes"
    for fid in ini.sections():
        f = rows.get(fid)
        if not f:
            continue
        if ini[fid].get("section"):
            print(f"\n{ini[fid]['section']}")
        note = ""
        if f[4] == "yes":
            note = "  (after a reboot)"
        if f[5] != "yes":
            note += f"  - {'unusable' if f[5] == 'no' else 'partly'}: {f[6]}"
        print(f"  [{'x' if f[2] == 'on' else ' '}] {fid:20} {ini[fid].get('title', '')}{note}")
    if reboot:
        print("\nSome changes wait for a reboot.")


def cmd_set(args):
    require_flipfull()
    value = "on" if args.cmd == "on" else "off"
    rc = flipfull("set", *(f"{i} {value}" for i in args.ids), live=True)
    if rc != 0:
        sys.exit(1)
    waiting = any(line == "reboot\tyes" for line in flipfull("state").splitlines())
    finish(args, "done", needs_reboot=waiting)


def cmd_install_app(args):
    require_flipfull()
    zip_path = Path(args.application)
    if not zip_path.is_file() or zip_path.suffix.lower() != ".zip":
        sys.exit(f"not an application.zip: {zip_path}")
    remote = f"/data/local/tmp/flip4-{zip_path.name}"
    adb("push", str(zip_path), remote)
    try:
        rc = flipfull("install-app", f"'{remote}'", live=True)
    finally:
        sh(f"rm -f '{remote}'", check=False)
    sys.exit(rc)


def import_google_client(path):
    remote = "/data/local/tmp/flip4-client_secret.json"
    adb("push", str(path), remote)
    try:
        return flipfull("google-client", "import", remote, live=True)
    finally:
        sh(f"rm -f {remote}", check=False)


def cmd_google_client(args):
    require_flipfull()
    if args.remove:
        sys.exit(flipfull("google-client", "remove", live=True))
    path = Path(args.file) if args.file else google_client_file()
    if not path:
        sys.exit("no client_secret*.json in the repo root; name the file")
    if import_google_client(path) != 0:
        sys.exit(1)
    print("Turn on the google-accounts feature (flip4.py on google-accounts --reboot) if it's off.")


def cmd_status(args):
    require_flipfull()
    flipfull("status", live=True)


def cmd_restart(args):
    require_flipfull()
    sys.exit(flipfull("restart", *(f"'{a}'" for a in args.apps), live=True))


def cmd_mon(args):
    require_root()
    script = f"{UI}/tools/mon.sh"
    if not sh(f"ls {script} 2>/dev/null", check=False):
        sys.exit("the phone's userinit is older than this command - run `flip4.py install` first")
    names = " ".join(f"'{n}'" for n in args.names)
    try:
        subprocess.run([ADB, "shell", f"sh {script} -i {args.interval} {names}"])
    except KeyboardInterrupt:
        print()


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
    require_flipfull()
    flipfull("uninstall", live=True)
    finish(args, "uninstall scheduled")


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
    names = [a["name"] for a in apps]
    core = {a["name"]: a["core"] for a in apps if a["core"]}
    while True:
        print("\nPreloaded apps ([x] = can be uninstalled from the app list):")
        for i, a in enumerate(apps, 1):
            note = f"  (core: {a['core']})" if a["core"] else ""
            print(f"  {i:3} [{'x' if a['name'] in chosen else ' '}] {a['name']}{note}")
        answer = input("\nToggle numbers (e.g. 3 7-9), a = all but core, n = none, "
                       "Enter = save, q = quit: ").strip().lower()
        if answer == "":
            return chosen
        if answer == "q":
            return None
        if answer == "a":
            chosen = {n for n in names if n not in core}
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
            elif name in core and input(
                    f"  {name} is {core[name]}; without it the phone may not work. "
                    "Make it removable anyway? [y/N] ").strip().lower() != "y":
                continue
            else:
                chosen.add(name)


def cmd_removable(args):
    require_flipfull()
    apps = []
    for line in flipfull("removable").splitlines():
        f = line.split("\t")
        if f[0] == "app" and len(f) >= 6:
            apps.append({"name": f[1], "now": f[2] == "1", "chosen": f[3] == "1", "core": f[5]})
    if not apps:
        sys.exit("couldn't read the preloaded apps from the phone")
    names = {a["name"] for a in apps}
    now = {a["name"] for a in apps if a["chosen"]}
    if args.list:
        for a in apps:
            pending = "" if a["chosen"] == a["now"] else " (from the next boot)"
            print(f"{'x' if a['chosen'] else ' '} {a['name']}{pending}")
        return
    unknown = sorted(set(args.add + args.remove) - names)
    if unknown:
        sys.exit(f"not preloaded apps: {', '.join(unknown)} (see `flip4.py removable --list`)")
    core = {a["name"] for a in apps if a["core"]}
    if args.all:
        chosen = (names - core) | (now & core)
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
    if flipfull("removable", "set", *sorted(chosen), live=True) != 0:
        sys.exit(1)
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


def finish(args, what, needs_reboot=True):
    if getattr(args, "reboot", False):
        adb("reboot")
        print(f"{what}; rebooting")
    elif needs_reboot:
        print(f"{what}; reboot to apply (adb reboot)")
    else:
        print(what)


def main():
    global ADB
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="rebuild overlays and apps into userinit/")
    b.add_argument("targets", nargs="*")
    i = sub.add_parser("install", help="install / update Flipfull on the phone")
    i.add_argument("--no-build", action="store_true", help="push userinit/ as it is")
    i.add_argument("--reboot", action="store_true")
    rl = sub.add_parser("release", help="build a zip with install.sh / install.bat (default dist/)")
    rl.add_argument("dir", nargs="?")
    rl.add_argument("--no-build", action="store_true", help="zip userinit/ as it is")
    sub.add_parser("features", help="list the features and which are on")
    for name in ("on", "off"):
        s = sub.add_parser(name, help=f"turn features {name} (ids: `flip4.py features`)")
        s.add_argument("ids", nargs="+", metavar="ID")
        s.add_argument("--reboot", action="store_true", help="reboot if a change waits for one")
    sub.add_parser("status", help="show what is installed and running")
    rt = sub.add_parser("restart", help="restart the phone's UI (b2g) without a reboot, "
                        "or only the named apps (launcher, settings, ...)")
    rt.add_argument("apps", nargs="*", metavar="APP")
    ia = sub.add_parser("install-app", help="install a local application.zip on the phone")
    ia.add_argument("application", metavar="application.zip",
                    help="path to the application.zip on the PC")
    mn = sub.add_parser("mon", help="memory (RSS) and CPU of processes every second, until Ctrl-C",
                        description="NAME is a process name (stt-server, callrecd, b2g, api-daemon, "
                        "an app: launcher, settings, ...) or, if nothing has that name, text in a "
                        "command line (CallRec: the call recorder while recording). CPU is % of "
                        "one core; the phone has 8.")
    mn.add_argument("names", nargs="+", metavar="NAME")
    mn.add_argument("-i", "--interval", type=int, default=1, metavar="SECONDS")
    r = sub.add_parser("removable", help="choose which preloaded apps can be uninstalled "
                       "(interactive without options)")
    g = r.add_mutually_exclusive_group()
    g.add_argument("--all", action="store_true", help="every preloaded app except the core ones")
    g.add_argument("--none", action="store_true", help="none (as the phone came)")
    g.add_argument("--list", action="store_true", help="show which are removable")
    r.add_argument("--add", nargs="+", default=[], metavar="APP")
    r.add_argument("--remove", nargs="+", default=[], metavar="APP")
    r.add_argument("--reboot", action="store_true")
    gc = sub.add_parser("google-client", help="use your own Google sign-in client "
                        "(default: client_secret*.json in the repo root)")
    gc.add_argument("file", nargs="?")
    gc.add_argument("--remove", action="store_true")
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

    if args.cmd not in ("build", "release"):
        ADB = find_adb()
    {"build": cmd_build, "install": cmd_install, "release": cmd_release, "features": cmd_features,
     "on": cmd_set, "off": cmd_set, "install-app": cmd_install_app, "status": cmd_status,
     "restart": cmd_restart, "mon": cmd_mon, "removable": cmd_removable,
     "google-client": cmd_google_client, "backup": cmd_backup, "restore": cmd_restore,
     "cleanup": cmd_cleanup, "uninstall": cmd_uninstall}[args.cmd](args)


if __name__ == "__main__":
    main()
