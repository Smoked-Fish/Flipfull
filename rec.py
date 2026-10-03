import re
import subprocess
import sys
import tempfile
from pathlib import Path

KAICAP = "/data/local/tmp/kaicap"
REMOTE = "/data/local/tmp/rec.raw"
W, H, SCALE = 240, 320, 2


def adb(*args, **kw):
    return subprocess.run(["adb", *args], capture_output=True, text=True, **kw)


def main():
    a = sys.argv[1:]
    secs = a[0] if len(a) > 0 else "10"
    fps = a[1] if len(a) > 1 else "20"
    out = Path(a[2] if len(a) > 2 else "rec.mp4")

    adb("root")
    adb("wait-for-device")
    print(f"recording {secs}s at {fps} fps (screen must be on)...")
    r = adb("shell", KAICAP, REMOTE, secs, fps)
    log = r.stdout + r.stderr
    m = re.search(r"done: (\d+) frames in [\d.]+s \(([\d.]+) fps effective\)", log)
    if not m:
        sys.exit(f"kaicap failed:\n{log}")
    frames, effective = m.group(1), m.group(2)
    print(f"{frames} frames, {effective} fps effective")

    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "rec.raw"
        p = adb("pull", REMOTE, str(raw))
        if p.returncode:
            sys.exit(p.stderr)
        adb("shell", "rm", REMOTE)
        cmd = ["ffmpeg", "-y", "-loglevel", "error",
               "-f", "rawvideo", "-pixel_format", "rgb565le", "-video_size", f"{W}x{H}",
               "-framerate", effective, "-i", str(raw),
               "-vf", f"scale={W * SCALE}:{H * SCALE}:flags=neighbor"]
        if out.suffix != ".gif":
            cmd += ["-pix_fmt", "yuv420p"]
        if subprocess.run(cmd + [str(out)]).returncode:
            sys.exit("ffmpeg failed")
    print(f"saved {out.resolve()}")


if __name__ == "__main__":
    main()
