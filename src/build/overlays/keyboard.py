"""The keyboard: voice input (dictation) from src/overlays/keyboard/voice_input.js."""

from ..edits import Overlay, Splice
from ..paths import OVERLAY_SRC

OVERLAY = Overlay(
    edits=[
        Splice("js/keypad.js",
               "Keypad.prototype._startVoiceInput=function(){",
               "Keypad.prototype._clearAllTimers=",
               OVERLAY_SRC / "keyboard" / "voice_input.js"),
    ],
    # src/overlays/keyboard/ only holds the splice source
    extra_files=False,
)
