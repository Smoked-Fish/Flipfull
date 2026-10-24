import fnmatch
import hashlib
import re
import shutil
import subprocess
import zipfile

from .errors import BuildError, PatchError
from .paths import BASE, OVERLAY_SRC, ROOT, USERINIT

ZIP_DATE = (2026, 1, 1, 0, 0, 0)


def zip_entry(path):
    info = zipfile.ZipInfo(path, date_time=ZIP_DATE)
    info.external_attr = 0o644 << 16
    return info


def build_overlay(name, overlay):
    base = BASE / name
    out = USERINIT / "overlays" / name
    out.mkdir(parents=True, exist_ok=True)
    zip_out = out / "application.zip"
    tmp = out / "application.zip.tmp"
    try:
        write_overlay_zip(name, overlay, base / "application.zip", tmp)
        tmp.replace(zip_out)
    finally:
        tmp.unlink(missing_ok=True)

    if (base / "manifest.webmanifest").exists():
        shutil.copyfile(base / "manifest.webmanifest", out / "manifest.webmanifest")
    stock = overlay.stock_md5 or hashlib.md5((base / "application.zip").read_bytes()).hexdigest()
    (out / "stock.md5").write_text(stock + "\n", encoding="utf-8", newline="\n")
    print(f"{name:10} -> {zip_out.relative_to(ROOT)} ({zip_out.stat().st_size} bytes)")


def removed(overlay, path):
    return any(fnmatch.fnmatchcase(path, r) for r in overlay.remove)


def write_overlay_zip(name, overlay, stock_zip, dest):
    added = overlay_files(name, overlay)
    with zipfile.ZipFile(stock_zip) as zin:
        check_paths(name, overlay, zin.namelist())
        with zipfile.ZipFile(dest, "w") as zout:
            for info in zin.infolist():
                path = info.filename
                if removed(overlay, path):
                    continue
                data = added.pop(path, None)
                if data is None:
                    data = zin.read(path)
                edits = [e for e in overlay.edits if e.matches(path)]
                if edits:
                    data = apply_edits(name, path, data.decode("utf-8"), edits).encode("utf-8")
                zout.writestr(info, data, compress_type=info.compress_type)
            for path, data in added.items():
                zout.writestr(zip_entry(path), data, compress_type=zipfile.ZIP_DEFLATED)


def overlay_files(name, overlay):
    files_dir = OVERLAY_SRC / name
    if not overlay.extra_files or not files_dir.is_dir():
        return {}
    return {p.relative_to(files_dir).as_posix(): p.read_bytes()
            for p in sorted(files_dir.rglob("*")) if p.is_file()}


def check_paths(name, overlay, names):
    """Every file the overlay removes or edits is in the stock zip"""
    missing = [r for r in overlay.remove if not any(fnmatch.fnmatchcase(n, r) for n in names)]
    if missing:
        raise BuildError(f"{name}: files to remove not in the base zip: {missing}")
    kept = [n for n in names if not removed(overlay, n)]
    unmatched = sorted({e.path for e in overlay.edits if not any(e.matches(n) for n in kept)})
    if unmatched:
        raise BuildError(f"{name}: files to patch not in the base zip: {unmatched}")


def apply_edits(name, path, text, edits):
    for edit in edits:
        try:
            text = edit.apply(text)
        except PatchError as e:
            raise BuildError(f"{name}/{path}: {e}")
    return text


def release_version():
    try:
        tag = subprocess.run(["git", "-C", str(ROOT), "describe", "--tags", "--abbrev=0"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
    except OSError:
        return None
    m = re.fullmatch(r"v?(\d+(?:\.\d+)*)", tag)
    return m.group(1) if m else None


def with_version(manifest, version):
    text, n = re.subn(r'("version"\s*:\s*")[^"]*(")', rf"\g<1>{version}\g<2>", manifest.decode("utf-8"), count=1)
    if not n:
        raise BuildError("the manifest has no version")
    return text.encode("utf-8")


def build_app(name, folder, released=False):
    out = USERINIT / "apps" / name
    out.mkdir(parents=True, exist_ok=True)
    zip_out = out / "application.zip"
    manifest = (folder / "manifest.webmanifest").read_bytes()
    version = release_version() if released else None
    if version:
        manifest = with_version(manifest, version)
    with zipfile.ZipFile(zip_out, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                rel = path.relative_to(folder).as_posix()
                data = manifest if rel == "manifest.webmanifest" else path.read_bytes()
                z.writestr(zip_entry(rel), data, compress_type=zipfile.ZIP_DEFLATED)
    (out / "manifest.webmanifest").write_bytes(manifest)
    print(f"{name:10} -> {zip_out.relative_to(ROOT)}{f' (version {version})' if version else ''}")
