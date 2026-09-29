class BuildError(Exception):
    """build() prints the message and exits"""

class PatchError(BuildError):
    """A stock file isn't what an edit expects, so the edit can't be made safely."""
