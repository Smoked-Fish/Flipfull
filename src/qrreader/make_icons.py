
import struct
import zlib
from pathlib import Path

import segno

OUT = Path(__file__).resolve().parent / "app" / "img"
BG = (0x80, 0x00, 0xFF)
FG = (0xFF, 0xFF, 0xFF)


def png(path, width, height, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9))
                     + chunk(b"IEND", b""))


def icon(size):
    matrix = [list(row) for row in segno.make("QR", error="l", micro=False).matrix]
    n = len(matrix)
    module = (size * 3 // 4) // n
    offset = (size - module * n) // 2
    radius = size // 5
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            cx = min(max(x, radius), size - 1 - radius)
            cy = min(max(y, radius), size - 1 - radius)
            if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                row += bytes((0, 0, 0, 0))
                continue
            mx, my = (x - offset) // module, (y - offset) // module
            dark = 0 <= mx < n and 0 <= my < n and x >= offset and y >= offset and matrix[my][mx]
            row += bytes((*(FG if dark else BG), 255))
        rows.append(bytes(row))
    out = OUT / f"qrreader_{size}.png"
    png(out, size, size, rows)
    print(out.relative_to(Path.cwd()) if out.is_relative_to(Path.cwd()) else out)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for s in (56, 112):
        icon(s)
