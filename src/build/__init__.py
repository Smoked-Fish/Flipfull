"""
Targets, all of them unless some are named:
  overlays  a stock app with Flipfull's changes
  apps      Flipfull's own apps, userinit/apps/<name>/
  stt       the speech-to-text models, downloaded to userinit/services/stt/models/

userinit/features.ini and the camera profiles are checked first.

  overlays/    one module per stock app
  edits.py     Overlay, and the edits it lists (Patch, Rewrite, Splice)
  snippets.py  JS and HTML that many overlays put in
  textops.py   strict cut and replace, for Rewrite functions
  zips.py      writes the application.zip files
  stt.py       downloads the models
  features.py, camera.py
"""

import sys
from functools import partial

from . import stt, zips
from .camera import check_camera_profiles
from .errors import BuildError
from .features import check_features, release_features
from .overlays import OVERLAYS
from .paths import SRC

__all__ = ["APPS", "OVERLAYS", "TARGETS", "BuildError", "build", "release_features"]

# Flipfull's own apps, by the folder that is zipped
APPS = {
    "kaiva": SRC / "kaiva" / "app", #todo move to flipstore
    "flipfull": SRC / "toolbox" / "app",
}

TARGETS = {
    **{name: partial(zips.build_overlay, name, overlay) for name, overlay in OVERLAYS.items()},
    **{name: partial(zips.build_app, name, folder) for name, folder in APPS.items()},
    "stt": stt.fetch_models,
}


def build(names=None):
    """Builds the named targets, or all of them. A failure exits with its reason."""
    try:
        unknown = [name for name in names or [] if name not in TARGETS]
        if unknown:
            raise BuildError(f"unknown target {', '.join(unknown)}; choose from {', '.join(TARGETS)}")
        check_features(OVERLAYS, APPS)
        check_camera_profiles()
        for name in names or TARGETS:
            TARGETS[name]()
    except BuildError as e:
        sys.exit(f"build failed: {e}")
