"""The camera rework (src/overlays/camera/) in place of the stock Camera, which keeps its sounds and manifest."""

from ..edits import Overlay

OVERLAY = Overlay(remove=["__mocks__/*", "dist/*", "js/*", "locales-obj/*", "tools/*"])
