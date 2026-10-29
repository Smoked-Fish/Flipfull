"""
Targets, all of them unless some are named:
  overlays  every stock app with Flipfull's changes, or one by name (launcher, system, ...)
  apps      every one of Flipfull's own apps, userinit/apps/<name>/, or one by name

userinit/features.ini and the camera profiles are checked first.

  overlays/           one module per stock app
  edits.py            Overlay, the edits it lists (Patch, Rewrite, Splice), and the text helpers for Rewrite
  snippets.py         JS and HTML that many overlays put in
  zips.py             writes the application.zip files
  features.py         checks features.ini, and the features each overlay reads
  camera_profiles.py  checks userinit/etc/camera/profiles.xml
  ads.py              what the music and video overlays share for taking the ads out
"""

import sys
from functools import partial

from . import zips
from .camera_profiles import check_camera_profiles
from .edits import BuildError
from .features import check_features, release_features
from .overlays import OVERLAYS
from .paths import SRC

# Flipfull's own apps, by the folder that is zipped
APPS = {
    "kaiva": SRC / "kaiva" / "app",
    "flipfull": SRC / "flipfull" / "app",
    "retro": SRC / "retro" / "app",
}

TARGETS = {
    **{name: partial(zips.build_overlay, name, overlay) for name, overlay in OVERLAYS.items()},
    **{name: partial(zips.build_app, name, folder, released=name == "flipfull") for name, folder in APPS.items()},
}
GROUPS = {"overlays": list(OVERLAYS), "apps": list(APPS)}


def build(names=None):
    """Builds the named targets, or all of them. Failures exit with their reasons."""
    names = [target for name in names or TARGETS for target in GROUPS.get(name, [name])]
    unknown = [name for name in names if name not in TARGETS]
    if unknown:
        sys.exit(f"build failed: unknown target {', '.join(unknown)}; "
                 f"choose from {', '.join([*GROUPS, *TARGETS])}")
    try:
        check_features(OVERLAYS, APPS)
        check_camera_profiles()
    except BuildError as e:
        sys.exit(f"build failed: {e}")
    failed = []
    for name in names:
        try:
            TARGETS[name]()
        except BuildError as e:
            failed.append(f"{name}: {e}" if not str(e).startswith(name) else str(e))
    if failed:
        sys.exit("build failed:\n  " + "\n  ".join(failed))
