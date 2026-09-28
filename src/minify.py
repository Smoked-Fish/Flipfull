

import base64
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "src" / "overlays" / "base"
CACHE = ROOT / ".cache"

TARGET = "firefox123"

ESBUILD_VERSION = "0.28.2"
ESBUILD_SHA512 = {
    "win32-x64": "5ebpxr3nWMzrL/rnUI755Jkuee0bHL/Gq0WTF9lvcpv73wAp5eu8MfBUgWK9bhWvZjj7yX8etf/8tI8Ney695g==",
    "win32-arm64": "PIhhEkE9uPBleRBrQEJpUn7MBnibZzbGzYWPmY3x+YoVg/95zbjB4CxPPOQ8l5tYYM4mMaCthF8/1DIfBQQyWQ==",
    "linux-x64": "4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ==",
    "linux-arm64": "pW4AC0P3it8c7do9MVM4p51FzHzdM/TZrerurgRcHJ2WTa1VQ1CIq18xncfpBJw4ojkiZZrKW2yIBWBP92j6Ug==",
    "darwin-x64": "uq6suIWYP37qzGddBKPw5QEQPi6HiLGsO7UmkpfyaYNQ3D+rN6w6WfwH+nuqcGXWvawGwxOEroO4YGnFh95azw==",
    "darwin-arm64": "n4KqkOQrraxHJcgjM1RvwbigfQKIKJVpM7xp+KsxiyUSrRdIXnt73VhrPAx0fV44hgfmIVKjxMN9J1t5jySVkw==",
}


class MinifyError(Exception):
    pass


_esbuild = None


def esbuild():
    global _esbuild
    if _esbuild:
        return _esbuild
    if os.environ.get("ESBUILD"):
        _esbuild = os.environ["ESBUILD"]
        return _esbuild
    system = {"win32": "win32", "linux": "linux", "darwin": "darwin"}.get(sys.platform)
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())
    plat = f"{system}-{arch}"
    if plat not in ESBUILD_SHA512:
        raise MinifyError(f"no esbuild for {sys.platform} {platform.machine()}: set ESBUILD=/path/to/esbuild")
    win = system == "win32"
    exe = CACHE / f"esbuild-{ESBUILD_VERSION}-{plat}" / ("esbuild.exe" if win else "esbuild")
    if not exe.is_file():
        url = f"https://registry.npmjs.org/@esbuild/{plat}/-/{plat}-{ESBUILD_VERSION}.tgz"
        print(f"release    downloading esbuild {ESBUILD_VERSION} ({plat})")
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                tgz = r.read()
        except OSError as e:
            raise MinifyError(f"couldn't download {url}: {e}")
        if base64.b64encode(hashlib.sha512(tgz).digest()).decode() != ESBUILD_SHA512[plat]:
            raise MinifyError(f"{url} doesn't match its sha512")
        with tarfile.open(fileobj=io.BytesIO(tgz)) as t:
            binary = t.extractfile("package/esbuild.exe" if win else "package/bin/esbuild").read()
        exe.parent.mkdir(parents=True, exist_ok=True)
        part = exe.parent / (exe.name + ".part")
        part.write_bytes(binary)
        part.chmod(0o755)
        part.replace(exe)
    _esbuild = str(exe)
    return _esbuild


def run_esbuild(text, loader, what, rename=True):
    minify = ["--minify"] if rename else ["--minify-whitespace", "--minify-syntax"]
    r = subprocess.run([esbuild(), f"--loader={loader}", *minify, f"--target={TARGET}",
                        "--charset=utf8", "--legal-comments=none", "--log-level=error"],
                       input=text.encode("utf-8"), capture_output=True)
    if r.returncode:
        raise MinifyError(f"{what}: {r.stderr.decode('utf-8', 'replace').strip()}")
    return r.stdout.decode("utf-8")


def js(text, what="js", rename=True):
    return run_esbuild(text, "js", what, rename)


def css(text, what="css"):
    return run_esbuild(text, "css", what)


MARKUP = re.compile(r"<!--(.*?)-->|<(script|style|pre|textarea)\b([^>]*)>(.*?)</\2\s*>|<[^>]*>",
                    re.S | re.I)


def collapse(text):
    return re.sub(r"\s+", lambda m: "\n" if "\n" in m.group(0) else " ", text)


def html(text, what="html", rename=True):
    out = []
    pos = 0
    for m in MARKUP.finditer(text):
        out.append(collapse(text[pos:m.start()]))
        pos = m.end()
        whole = m.group(0)
        if whole.startswith("<!--"):
            if "<" in m.group(1):
                out.append(whole)
        elif m.group(2):
            tag, attrs, body = m.group(2), m.group(3), m.group(4)
            kind = tag.lower()
            script_type = re.search(r"""\btype\s*=\s*["']?([^"'\s>]+)""", attrs, re.I)
            if kind == "script" and body.strip() and (
                    not script_type or script_type.group(1).lower() in ("text/javascript", "application/javascript")):
                body = js(body, f"{what} <script>", rename).strip()
            elif kind == "style" and body.strip():
                body = css(body, f"{what} <style>").strip()
            out.append(f"<{tag}{attrs}>{body}</{tag}>")
        else:
            out.append(whole)
    out.append(collapse(text[pos:]))
    return "".join(out).strip() + "\n"


def json_min(text, what="json"):
    try:
        return json.dumps(json.loads(text), ensure_ascii=False, separators=(",", ":"))
    except ValueError as e:
        raise MinifyError(f"{what}: {e}")


def shell(text):
    lines = []
    cur = []
    stack = []
    heredocs = []
    in_code = ("$(", "`", "(")
    i, n = 0, len(text)
    if text.startswith("#!"):
        end = text.find("\n")
        end = n if end < 0 else end
        lines.append(text[:end])
        i = end + 1
    while i < n:
        c = text[i]
        top = stack[-1] if stack else None
        if c == "\n":
            line = "".join(cur)
            cur = []
            i += 1
            if top in (None,) + in_code:
                line = line.rstrip()
                after_continuation = bool(lines) and lines[-1].endswith("\\") and not lines[-1].endswith("\\\\")
                if line or after_continuation:
                    lines.append(line)
            else:
                lines.append(line)
            for strip, word in heredocs:
                while i < n:
                    end = text.find("\n", i)
                    end = n if end < 0 else end
                    body = text[i:end]
                    lines.append(body)
                    i = end + 1
                    if (body.lstrip("\t") if strip else body) == word:
                        break
            heredocs = []
            continue
        if top == "'":
            cur.append(c)
            if c == "'":
                stack.pop()
            i += 1
            continue
        if c == "\\" and i + 1 < n and text[i + 1] != "\n":
            cur.append(text[i:i + 2])
            i += 2
            continue
        if top == '"':
            if c == '"':
                stack.pop()
                cur.append(c)
                i += 1
                continue
        elif top == "${":
            if c == "}":
                stack.pop()
                cur.append(c)
                i += 1
                continue
            if c in "'\"":
                stack.append(c)
                cur.append(c)
                i += 1
                continue
        elif top == "$((":
            if text.startswith("))", i):
                stack.pop()
                cur.append("))")
                i += 2
                continue
            if c == "(":
                stack.append("(")
                cur.append(c)
                i += 1
                continue
        else:
            if c == "#" and (not cur or cur[-1][-1] in " \t;&|()<>"):
                while i < n and text[i] != "\n":
                    i += 1
                continue
            if c in "'\"":
                stack.append(c)
                cur.append(c)
                i += 1
                continue
            if c == "(":
                stack.append("(")
                cur.append(c)
                i += 1
                continue
            if c == ")":
                if top in ("(", "$("):
                    stack.pop()
                cur.append(c)
                i += 1
                continue
            if text.startswith("<<", i) and not text.startswith("<<<", i):
                m = re.compile(r"<<(-?)[ \t]*(['\"]?)\\?([A-Za-z_][A-Za-z0-9_]*)\2").match(text, i)
                if m:
                    heredocs.append((m.group(1) == "-", m.group(3)))
                    cur.append(m.group(0))
                    i = m.end()
                    continue
        if c == "`":
            if top == "`":
                stack.pop()
            else:
                stack.append("`")
            cur.append(c)
            i += 1
            continue
        if c == "$" and top != "$((":
            for opener in ("$((", "$(", "${"):
                if text.startswith(opener, i):
                    stack.append(opener)
                    cur.append(opener)
                    i += len(opener)
                    break
            else:
                cur.append(c)
                i += 1
            continue
        cur.append(c)
        i += 1
    if cur:
        tail = "".join(cur)
        lines.append(tail.rstrip() if not stack else tail)
    if stack:
        raise MinifyError(f"unbalanced {stack[-1]} at the end")
    return "\n".join(lines) + "\n"


def awk(text):
    out = []
    for line in text.split("\n"):
        kept = []
        i, n = 0, len(line)
        prev = ""
        while i < n:
            c = line[i]
            if c == "#":
                break
            if c in "\"/" and (c == '"' or not prev or prev in "(,~!{};&|=<>?:+-*%^"):
                end = i + 1
                while end < n and line[end] != c:
                    end += 2 if line[end] == "\\" else 1
                kept.append(line[i:end + 1])
                prev = c
                i = end + 1
                continue
            kept.append(c)
            if not c.isspace():
                prev = c
            i += 1
        code = "".join(kept).rstrip()
        if code:
            out.append(code)
    return "\n".join(out) + "\n"


def ini(text):
    return "\n".join(line.rstrip() for line in text.split("\n")
                     if line.strip() and not line.lstrip().startswith(("#", ";"))) + "\n"


def hosts(text):
    return "\n".join(line.split("#", 1)[0].rstrip() for line in text.split("\n")
                     if line.split("#", 1)[0].strip()) + "\n"


def bat(text):
    nl = "\r\n" if "\r\n" in text else "\n"
    return nl.join(line.rstrip() for line in text.replace("\r\n", "\n").split("\n")
                   if line.strip() and not re.match(r"\s*@?(rem(\s|$)|::)", line, re.I)) + nl


def prefs(text):
    out = re.sub(r"""("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|//[^\n]*|/\*.*?\*/""",
                 lambda m: m.group(1) or "", text, flags=re.S)
    return "\n".join(line.rstrip() for line in out.split("\n") if line.strip()) + "\n"


def minify_entry(name, data, rename):
    suffix = Path(name).suffix.lower()
    if suffix == ".js":
        return js(data.decode("utf-8"), name, rename).encode("utf-8")
    if suffix == ".css":
        return css(data.decode("utf-8"), name).encode("utf-8")
    if suffix in (".html", ".htm", ".svg"):
        return html(data.decode("utf-8"), name, rename).encode("utf-8")
    if suffix in (".json", ".webmanifest"):
        return json_min(data.decode("utf-8-sig"), name).encode("utf-8")
    return data


def app_zip(data, base=None, what="application.zip"):
    stock = {}
    if base:
        with zipfile.ZipFile(base) as b:
            stock = {i.filename: (i.CRC, i.file_size) for i in b.infolist()}
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as zin, zipfile.ZipFile(out, "w") as zout:
        for info in zin.infolist():
            content = zin.read(info)
            if not info.is_dir() and (base is None or stock.get(info.filename) != (info.CRC, info.file_size)):
                try:
                    new = minify_entry(info.filename, content, rename=base is None)
                except MinifyError as e:
                    raise MinifyError(f"{what}: {e}")
                if base is None or len(new) < len(content):
                    content = new
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.external_attr = info.external_attr
            zi.compress_type = info.compress_type
            zout.writestr(zi, content)
    return out.getvalue()


def text_kind(rel, data):
    name = rel.rsplit("/", 1)[-1]
    suffix = Path(name).suffix.lower()
    if suffix == ".sh" or (not suffix and data.startswith(b"#!") and b"sh" in data.split(b"\n", 1)[0]):
        return shell
    if rel.startswith("etc/prefs.d/") and suffix == ".js":
        return prefs
    return {".awk": awk, ".ini": ini, ".hosts": hosts, ".bat": bat, ".js": js, ".css": css}.get(suffix)


def check_shell(rel, before, after):
    sh = shutil.which("sh")
    if not sh:
        return
    def parses(text):
        return subprocess.run([sh, "-n"], input=text.encode("utf-8"), capture_output=True).returncode == 0
    if parses(before) and not parses(after):
        raise MinifyError(f"{rel}: doesn't parse after its comments were removed")


def release_file(rel, data):
    parts = rel.split("/")
    try:
        if parts[-1] == "application.zip" and parts[0] == "apps":
            return app_zip(data, what=rel)
        if parts[-1] == "application.zip" and parts[0] == "overlays":
            return app_zip(data, BASE / parts[1] / "application.zip", what=rel)
        kind = text_kind(rel, data)
        if not kind:
            return data
        text = data.decode("utf-8")
        out = kind(text)
        if kind is shell:
            check_shell(rel, text, out)
        return out.encode("utf-8")
    except MinifyError as e:
        raise MinifyError(str(e) if str(e).startswith(rel) else f"{rel}: {e}")
