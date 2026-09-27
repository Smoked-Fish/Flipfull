"""Makes a random placeholder boot animation and a silent boot sound in userinit/media/.
"""
import argparse
import colorsys
import math
import random
import struct
import sys
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "userinit" / "media"
INITLOGO = ROOT / "src" / "overlays" / "system" / "resources" / "branding" / "initlogo.png"

FPS = 24
LOOP_FRAMES = 72


def png(w, h, rows):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    raw = b"".join(b"\0" + bytes(r) for r in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def rgb(h, s, v):
    return tuple(round(c * 255) for c in colorsys.hsv_to_rgb(h % 1, s, v))


def make_scene(rng, w, h):
    base_hue = rng.random()
    top = rgb(base_hue, 0.6, 0.18)
    bottom = rgb(base_hue + 0.5, 0.6, 0.06)
    background = [bytearray(bytes(round(a + (b - a) * y / (h - 1)) for a, b in zip(top, bottom)) * w)
                  for y in range(h)]
    scale = min(w, h)
    balls = []
    for _ in range(rng.randint(5, 9)):
        r = rng.uniform(0.06, 0.16) * scale
        balls.append({
            "r": r,
            "color": rgb(base_hue + rng.uniform(-0.25, 0.25), rng.uniform(0.5, 0.9), rng.uniform(0.75, 1)),
            "fx": rng.randint(1, 3), "fy": rng.randint(1, 3),
            "px": rng.uniform(0, 2 * math.pi), "py": rng.uniform(0, 2 * math.pi),
            "ax": (w / 2 - r) * rng.uniform(0.4, 1), "ay": (h / 2 - r) * rng.uniform(0.4, 1),
        })
    return background, balls


def render(background, balls, w, h, t):
    rows = [bytearray(r) for r in background]
    for b in balls:
        cx = w / 2 + b["ax"] * math.sin(2 * math.pi * b["fx"] * t + b["px"])
        cy = h / 2 + b["ay"] * math.sin(2 * math.pi * b["fy"] * t + b["py"])
        r = b["r"]
        rim = tuple(c // 2 for c in b["color"])
        for y in range(max(0, int(cy - r)), min(h, int(cy + r) + 1)):
            dy = y + 0.5 - cy
            if dy * dy > r * r:
                continue
            half = math.sqrt(r * r - dy * dy)
            x0, x1 = max(0, int(cx - half)), min(w, int(cx + half) + 1)
            if x1 <= x0:
                continue
            rows[y][x0 * 3:x1 * 3] = bytes(b["color"]) * (x1 - x0)
            for x in (x0, x1 - 1):
                rows[y][x * 3:x * 3 + 3] = bytes(rim)
    return rows


def make_zip(path, rng, w, h):
    background, balls = make_scene(rng, w, h)
    frames = [png(w, h, render(background, balls, w, h, i / LOOP_FRAMES)) for i in range(LOOP_FRAMES)]
    tmp = path.with_suffix(".zip.tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        def add(name, data):
            zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            zi.external_attr = 0o644 << 16
            z.writestr(zi, data, compress_type=zipfile.ZIP_STORED)
        add("desc.txt", f"{w} {h} {FPS}\np 0 0 part0\n")
        for i, frame in enumerate(frames):
            add(f"part0/{i:03d}.png", frame)
    tmp.replace(path)
    print(f"{path.relative_to(ROOT)}: {w}x{h}, {LOOP_FRAMES} frames, {path.stat().st_size} bytes")
    return frames[0]


def silent_wav(path, seconds=0.1, rate=8000):
    data = b"\0\0" * int(rate * seconds)
    header = (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
              + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
              + b"data" + struct.pack("<I", len(data)))
    path.write_bytes(header + data)
    print(f"{path.relative_to(ROOT)}: {seconds} s of silence")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed", type=int, help="random seed (default: a new one every run)")
    args = ap.parse_args()
    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(1 << 30)
    print(f"seed {seed}")
    OUT.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    first = make_zip(OUT / "bootanimation.zip", rng, 240, 320)
    INITLOGO.parent.mkdir(parents=True, exist_ok=True)
    INITLOGO.write_bytes(first)
    print(f"{INITLOGO.relative_to(ROOT)}: first frame")
    make_zip(OUT / "bootanimation_external.zip", rng, 128, 160)
    silent_wav(OUT / "poweron-sound.wav")


if __name__ == "__main__":
    sys.exit(main())
