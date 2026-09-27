"""One place to build, install, inspect and remove everything custom on the phone.

    python flip4.py build [target ...]   rebuild overlays + KaiVA into userinit/
    python flip4.py install [--reboot]   put userinit/ on the phone (builds first)
    python flip4.py status               what is installed and running
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
REPLACED_APPS = {"Dictate": "http://dictate.localhost/manifest.webmanifest"}
FWD_PORT = 6123
TEXT_SUFFIXES = {".sh", ".js", ".md", ".conf", ".rc"}
TEXT_NAMES = {"hosts"}
RUNTIME = ("run.log", "run.log.old", "busybox-path.sh", "bin/bbx/", "uninstall",
           "disable", "services/stt/server.log", "services/stt/server.log.old",
           "services/stt/stt.conf")


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


def install_kaiva():
    apps = installed_apps()
    replaced = [name for name, url in REPLACED_APPS.items() if url in apps]
    for name in replaced:
        r = apps_cmd("uninstall", REPLACED_APPS[name])
        print(f"{name}:", "uninstalled, KaiVA replaces it" if apps_ok(r) else f"not uninstalled ({r})")
    if replaced and KAIVA_URL in apps:
        apps_cmd("uninstall", KAIVA_URL)
    fresh = KAIVA_URL not in installed_apps()

    tmp_zip = "/data/local/tmp/userinit-kaiva.zip"
    sh(f"cp {UI}/apps/kaiva/application.zip {tmp_zip} && chmod 0644 {tmp_zip}")
    r = apps_cmd("install", tmp_zip)
    sh(f"rm -f {tmp_zip}", check=False)
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
    build.build(args.targets)


def cmd_install(args):
    require_root()
    if sh(f"ls {HOOK_RC}", check=False) != HOOK_RC:
        print(f"WARNING: {HOOK_RC} is missing - nothing in userinit will run at boot "
              "until the boot hook is flashed (src/boot-hook/README.md)")
    if not args.no_build:
        cmd_build(argparse.Namespace(targets=[]))

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

    print(sh(f"sh {UI}/boot-completed.d/50-services.sh", check=False))
    print("Overlays and Gecko prefs apply at the next boot.")
    finish(args, "installed")


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
    print("\nvoice apps:")
    try:
        apps = installed_apps()
        print("  KaiVA:", "installed" if KAIVA_URL in apps else "not installed")
        for name, url in REPLACED_APPS.items():
            if url in apps:
                print(f"  {name}: still installed (flip4.py install replaces it)")
    except OSError as e:
        print(f"  app list unavailable ({e})")
    print("\nGecko prefs block:", "present" if sh(
        "grep -l '^// >>> userinit' /data/b2g/mozilla/*.default/user.js 2>/dev/null",
        check=False) else "not written yet (next boot)")
    print("\nlast boot (run.log):")
    print(sh(f"tail -15 {UI}/run.log 2>/dev/null", check=False))


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
    print(sh(f"[ -f {UI}/post-fs-data.d/30-gecko-prefs.sh ] && sh {UI}/post-fs-data.d/30-gecko-prefs.sh remove",
             check=False))
    apps = installed_apps()
    for name, url in {"KaiVA": KAIVA_URL, **REPLACED_APPS}.items():
        if url in apps:
            r = apps_cmd("uninstall", url)
            print(f"{name}:", "uninstalled" if apps_ok(r) else f"not uninstalled ({r})")
    push_changed(["run.sh"])
    sh(f"chmod 0755 {UI}/run.sh; touch {UI}/uninstall")
    print("Everything else is removed at the next boot; the phone then boots stock.")
    print("(Changed your mind before rebooting? `flip4.py install` cancels it.)")
    finish(args, "uninstall scheduled")


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
    i.add_argument("--reboot", action="store_true")
    sub.add_parser("status", help="show what is installed and running")
    c = sub.add_parser("cleanup", help="delete files left by the old layouts")
    c.add_argument("--yes", action="store_true", help="don't ask")
    u = sub.add_parser("uninstall", help="remove everything (completes at the next boot)")
    u.add_argument("--reboot", action="store_true")
    args = p.parse_args()

    if args.cmd != "build":
        ADB = find_adb()
    {"build": cmd_build, "install": cmd_install, "status": cmd_status,
     "cleanup": cmd_cleanup, "uninstall": cmd_uninstall}[args.cmd](args)


if __name__ == "__main__":
    main()
