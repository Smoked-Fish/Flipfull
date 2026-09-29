from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
USERINIT = ROOT / "userinit"

# src/overlays/<name>/
OVERLAY_SRC = SRC / "overlays"
# src/overlays/base/<name>/
BASE = OVERLAY_SRC / "base"
