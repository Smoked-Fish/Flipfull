"""
  Patch(path, old, new)            old must appear exactly once and replace with new
  insert_before / insert_after     a Patch that keeps its anchor
  Rewrite(path, function)          function(text), using the helpers below
  prepend / append                 add text at the start / end
  Splice(path, start, end, file)   the text from start up to end becomes the file

path is a file in the zip, or a glob for several. Edits are made in order
"""

import fnmatch
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

# the ids of the features a piece of code reads from window.FlipfullFeatures
FEATURE_READS = re.compile(r"""FlipfullFeatures\s*\[\s*["']([a-z0-9-]+)["']\s*\]"""
                           r"""|FlipfullFeatures\.([a-z][a-z0-9_]*)"""
                           r"""|featureOn\(\s*["']([a-z0-9-]+)["']\s*\)""")


class BuildError(Exception):
    """build() prints the message and exits"""


class PatchError(BuildError):
    """A stock file isn't what an edit expects, so the edit can't be made safely."""


def features_read(text):
    return {next(g for g in m.groups() if g) for m in FEATURE_READS.finditer(text)}


def shown(text):
    return repr(text if len(text) <= 200 else text[:197] + "...")


@dataclass(frozen=True)
class Edit:
    path: str

    def matches(self, name):
        return fnmatch.fnmatchcase(name, self.path)

    def apply(self, text):
        raise NotImplementedError

    def features(self):
        return set()


@dataclass(frozen=True)
class Patch(Edit):
    old: str
    new: str

    def apply(self, text):
        return replace_exact(text, self.old, self.new, "anchor")

    def features(self):
        return features_read(self.new)


@dataclass(frozen=True)
class Rewrite(Edit):
    function: Callable[[str], str]

    def apply(self, text):
        try:
            return self.function(text)
        except PatchError as e:
            raise PatchError(f"{self.function.__name__}: {e}")


@dataclass(frozen=True)
class Add(Edit):
    text: str
    at_start: bool = False

    def apply(self, text):
        return self.text + text if self.at_start else text + self.text

    def features(self):
        return features_read(self.text)


@dataclass(frozen=True)
class Splice(Edit):
    start: str
    end: str
    source: Path

    def apply(self, text):
        i, j = span(text, self.start, self.end, "splice")
        return text[:i] + self.source.read_text(encoding="utf-8") + text[j:]

    def features(self):
        return features_read(self.source.read_text(encoding="utf-8"))


def insert_before(path, anchor, text):
    return Patch(path, anchor, text + anchor)


def insert_after(path, anchor, text):
    return Patch(path, anchor, anchor + text)


def prepend(path, text):
    return Add(path, text, at_start=True)


def append(path, text):
    return Add(path, text)


@dataclass
class Overlay:
    """A stock app with Flipfull's changes.

    edits      made to the matching stock files
    remove     stock files left out of the zip, or globs
    shows      when a change to a feature shows: reopen (the app), restart (flipfull restarts it) or ui (a UI restart)
    stock_md5  the md5 of the phone's stock application.zip, no overlay if it doesn't match stock

    The files in src/overlays/<name>/ go into the zip, except Splice sources, and the index pages
    load features.js when the overlay reads any feature.
    """
    edits: list[Edit] = field(default_factory=list)
    remove: list[str] = field(default_factory=list)
    shows: str = "reopen"
    stock_md5: str | None = None


def replace_exact(text, old, new, what, count=1):
    found = text.count(old)
    if found != count:
        raise PatchError(f"{what} found {found} times, expected {count}: {shown(old)}")
    return text.replace(old, new)


def remove_exact(text, old, what, count=1):
    return replace_exact(text, old, "", what, count)


def span(text, start, end, what):
    """Where start is, and where end is after it. Each must appear exactly once."""
    for marker in (start, end):
        if text.count(marker) != 1:
            raise PatchError(f"{what}: found {text.count(marker)} times, expected 1: {shown(marker)}")
    i, j = text.index(start), text.index(end)
    if j < i:
        raise PatchError(f"{what}: {shown(end)} comes before {shown(start)}")
    return i, j


def remove_span(text, start, end, what):
    """Remove from start through end"""
    i, j = span(text, start, end, what)
    return text[:i] + text[j + len(end):]


def js_group_end(text, i):
    """Index just past the bracket group that opens at text[i], skipping strings."""
    stack = []
    j = i
    while j < len(text):
        c = text[j]
        top = stack[-1] if stack else None
        if top in ('"', "'"):
            if c == "\\":
                j += 1
            elif c == top:
                stack.pop()
        elif top == "`":
            if c == "\\":
                j += 1
            elif c == "`":
                stack.pop()
            elif text.startswith("${", j):
                stack.append("${")
                j += 1
        elif c in "\"'`({[":
            stack.append(c)
        elif c in ")}]":
            stack.pop()
            if not stack:
                return j + 1
        j += 1
    raise PatchError(f"unbalanced group at {i}")


def cut(text, start, what, then=""):
    """Remove start, the bracket group it opens, and then"""
    if text.count(start) != 1 or start[-1] not in "({[":
        raise PatchError(f"{what}: found {text.count(start)} times, expected 1: {shown(start)}")
    i = text.index(start)
    j = js_group_end(text, i + len(start) - 1)
    if then:
        if not text.startswith(then, j):
            raise PatchError(f"{what}: expected {shown(then)} after it")
        j += len(then)
    return text[:i] + text[j:]


def remove_if_block(text, start, what):
    """Remove the whole if statment block"""
    if text.count(start) != 1:
        raise PatchError(f"{what}: found {text.count(start)} times, expected 1: {shown(start)}")
    i = text.index(start)
    cond_end = js_group_end(text, text.index("(", i))
    block = text.index("{", cond_end)
    if text[cond_end:block].strip():
        raise PatchError(f"{what}: no block after the condition")
    end = js_group_end(text, block)
    return text[:i] + text[end:].lstrip(" ").lstrip("\n")


def remove_css_rules(text, pattern, expected, what):
    """Remove the CSS rules whose selector matches patter"""
    text, n = re.subn(r"[^{}]*(" + pattern + r")[^{}]*\{[^}]*\}", "", text)
    if not expected(n):
        raise PatchError(f"{what}: found {n} rules for {pattern!r}")
    return text
