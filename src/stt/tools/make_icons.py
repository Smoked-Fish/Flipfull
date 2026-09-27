
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"
BG = (11, 122, 117)
FG = (255, 255, 255)
SS = 4


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def coverage(x, y):
    bg = math.hypot(x - 0.5, y - 0.5) <= 0.48
    fg = seg_dist(x, y, 0.5, 0.30, 0.5, 0.48) <= 0.105
    r = math.hypot(x - 0.5, y - 0.47)
    if y >= 0.47 and abs(r - 0.175) <= 0.028:
        fg = True
    fg = fg or seg_dist(x, y, 0.5, 0.645, 0.5, 0.74) <= 0.028
    fg = fg or seg_dist(x, y, 0.40, 0.745, 0.60, 0.745) <= 0.028
    return bg, fg


def render(size):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            nbg = nfg = 0
            for sy in range(SS):
                for sx in range(SS):
                    bg, fg = coverage((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
                    nbg += bg
                    nfg += bg and fg
            n = SS * SS
            a = nbg / n
            f = nfg / nbg if nbg else 0.0
            rgb = [round(BG[i] * (1 - f) + FG[i] * f) for i in range(3)]
            row += bytes(rgb + [round(a * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for s in (56, 112):
        (OUT / f"dictate_{s}.png").write_bytes(render(s))
        print("wrote", OUT / f"dictate_{s}.png")
