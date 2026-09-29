"""
  Patch(path, old, new)            old must appear exactly once and replace with new
  insert_before / insert_after     a Patch that keeps its anchor
  Rewrite(path, function)          function(text), may raise PatchError
  prepend / append                 a Rewrite that adds text at the start / end
  Splice(path, start, end, file)   the text from start up to end becomes the file

path is a file in the zip, or a glob for several. Edits are made in order
"""

import fnmatch
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .errors import PatchError


@dataclass(frozen=True)
class Edit:
    path: str

    def matches(self, name):
        return fnmatch.fnmatchcase(name, self.path)

    def apply(self, text):
        raise NotImplementedError


@dataclass(frozen=True)
class Patch(Edit):
    old: str
    new: str

    def apply(self, text):
        found = text.count(self.old)
        if found != 1:
            raise PatchError(f"anchor found {found} times, expected 1:\n  {self.old!r}")
        return text.replace(self.old, self.new)


@dataclass(frozen=True)
class Rewrite(Edit):
    function: Callable[[str], str]

    def apply(self, text):
        return self.function(text)


@dataclass(frozen=True)
class Splice(Edit):
    start: str
    end: str
    source: Path

    def apply(self, text):
        i, j = text.find(self.start), text.find(self.end)
        if text.count(self.start) != 1 or j < i:
            raise PatchError("splice markers not found as expected")
        return text[:i] + self.source.read_text(encoding="utf-8") + text[j:]


def insert_before(path, anchor, text):
    return Patch(path, anchor, text + anchor)


def insert_after(path, anchor, text):
    return Patch(path, anchor, anchor + text)


def prepend(path, text):
    return Rewrite(path, lambda old: text + old)


def append(path, text):
    return Rewrite(path, lambda old: old + text)


@dataclass
class Overlay:
    """A stock app with Flipfull's changes.

    edits        made to the matching stock files
    remove       stock files left out of the zip
    extra_files  whether the files in src/overlays/<name>/ go into the zip
    stock_md5    the md5 of the phone's stock application.zip, no overlay if it doesn't match stock
    """
    edits: list[Edit] = field(default_factory=list)
    remove: list[str] = field(default_factory=list)
    extra_files: bool = True
    stock_md5: str | None = None
