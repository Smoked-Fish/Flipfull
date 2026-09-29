"""Strict text operations for Rewrite functions."""

import re

from .errors import PatchError


def replace_exact(text, old, new, what, count=1):
    if text.count(old) != count:
        raise PatchError(f"{what}: found {text.count(old)} times, expected {count}")
    return text.replace(old, new)


def remove_exact(text, old, what, count=1):
    return replace_exact(text, old, "", what, count)


def remove_span(text, start, end, what):
    """Remove from start through end. each must appear exactly once."""
    if text.count(start) != 1 or text.count(end) != 1 or text.index(end) < text.index(start):
        raise PatchError(f"{what} changed")
    return text[:text.index(start)] + text[text.index(end) + len(end):]


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
        raise PatchError(f"{what}: found {text.count(start)} times, expected 1")
    i = text.index(start)
    j = js_group_end(text, i + len(start) - 1)
    if then:
        if not text.startswith(then, j):
            raise PatchError(f"{what}: expected {then!r} after it")
        j += len(then)
    return text[:i] + text[j:]


def remove_if_block(text, start, what):
    """Remove the whole if statment block"""
    if text.count(start) != 1:
        raise PatchError(f"{what} changed")
    i = text.index(start)
    cond_end = js_group_end(text, text.index("(", i))
    block = text.index("{", cond_end)
    if text[cond_end:block].strip():
        raise PatchError(f"{what} changed")
    end = js_group_end(text, block)
    return text[:i] + text[end:].lstrip(" ").lstrip("\n")


def remove_css_rules(text, pattern, expected, what):
    """Remove the CSS rules whose selector matches patter"""
    text, n = re.subn(r"[^{}]*(" + pattern + r")[^{}]*\{[^}]*\}", "", text)
    if not expected(n):
        raise PatchError(f"{what}: found {n} rules")
    return text
