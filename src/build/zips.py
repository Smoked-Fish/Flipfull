import hashlib
import shutil
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
    (out / "stock.md5").write_text(stock + "\n", newline="\n")
    print(f"{name:10} -> {zip_out.relative_to(ROOT)} ({zip_out.stat().st_size} bytes)")


def write_overlay_zip(name, overlay, stock_zip, dest):
    added = overlay_files(name, overlay)
    remove = set(overlay.remove)
    with zipfile.ZipFile(stock_zip) as zin:
        check_paths(name, overlay, zin.namelist())
        with zipfile.ZipFile(dest, "w") as zout:
            for info in zin.infolist():
                path = info.filename
                if path in remove:
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
    missing = sorted(set(overlay.remove) - set(names))
    if missing:
        raise BuildError(f"{name}: files to remove not in the base zip: {missing}")
    kept = [n for n in names if n not in overlay.remove]
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


def build_app(name, folder):
    out = USERINIT / "apps" / name
    out.mkdir(parents=True, exist_ok=True)
    zip_out = out / "application.zip"
    with zipfile.ZipFile(zip_out, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                z.writestr(zip_entry(path.relative_to(folder).as_posix()), path.read_bytes(),
                           compress_type=zipfile.ZIP_DEFLATED)
    shutil.copyfile(folder / "manifest.webmanifest", out / "manifest.webmanifest")
    print(f"{name:10} -> {zip_out.relative_to(ROOT)}")
