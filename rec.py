# python rec.py [front|back] [seconds] [fps] [output]

import re
import subprocess
import sys
import tempfile
from pathlib import Path

KAICAP = "/data/local/tmp/kaicap"
REMOTE = "/data/local/tmp/rec.raw"

PANELS = {
    "front": {
        "plane": 76,
        "width": 240,
        "height": 320,
        "card": "/dev/dri/card0",
    },
    "back": {
        "plane": 32,
        "width": 128,
        "height": 160,
        "card": "/dev/dri/card1",
    },
}


def adb(*args, **kw):
    return subprocess.run(["adb", *args], capture_output=True, text=True, **kw )


def main():
    a = sys.argv[1:]

    panel = a[0] if len(a) > 0 else "front"
    secs = a[1] if len(a) > 1 else "10"
    fps = a[2] if len(a) > 2 else "30"
    out = Path(a[3] if len(a) > 3 else f"{panel}.mp4")

    if panel not in PANELS:
        sys.exit(
            f"Unknown panel '{panel}'. "
            f"Choose: {', '.join(PANELS)}"
        )

    cfg = PANELS[panel]

    plane = cfg["plane"]
    width = cfg["width"]
    height = cfg["height"]
    card = cfg["card"]

    print(
        f"recording {panel} panel: "
        f"{width}x{height}, plane={plane}, card={card}, "
        f"{secs}s at {fps} fps..."
    )

    adb("root")
    adb("wait-for-device")
    r = adb("shell", KAICAP, REMOTE, secs, fps, str(plane), str(width), str(height), card)

    log = r.stdout + r.stderr
    print(log, end="")

    m = re.search(r"done: (\d+) frames in [\d.]+s \(([\d.]+) fps effective\)", log)

    if not m:
        sys.exit(f"kaicap failed:\n{log}")

    frames = m.group(1)
    effective = m.group(2)

    print(f"{frames} frames, {effective} fps effective")

    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "rec.raw"

        p = adb("pull", REMOTE, str(raw))

        if p.returncode:
            sys.exit(p.stderr)

        adb("shell", "rm", REMOTE)

        # Both panels are RGB565
        cmd = [
            "ffmpeg",
            "-y",
            "-loglevel", "error",
            "-f", "rawvideo",
            "-pixel_format", "rgb565le",
            "-video_size", f"{width}x{height}",
            "-framerate", effective,
            "-i", str(raw),
            "-vf", f"scale={width * 2}:{height * 2}:flags=neighbor",
        ]

        if out.suffix.lower() != ".gif":
            cmd += ["-pix_fmt", "yuv420p"]

        if subprocess.run(cmd + [str(out)]).returncode:
            sys.exit("ffmpeg failed")

    print(f"saved {out.resolve()}")


if __name__ == "__main__":
    main()
