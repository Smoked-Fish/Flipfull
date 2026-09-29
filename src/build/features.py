import configparser
import re

from .errors import BuildError
from .paths import USERINIT


def check_features(overlays, apps):
    ini = configparser.ConfigParser(interpolation=None)
    ini.read(USERINIT / "features.ini", encoding="utf-8")
    exists = {
        "overlays": lambda n: n in overlays,
        "apps": lambda n: n in apps,
        "services": lambda n: (USERINIT / "services" / n / "service.sh").is_file(),
        "hosts": lambda n: (USERINIT / "etc" / "hosts.d" / f"{n}.hosts").is_file(),
        "prefs": lambda n: (USERINIT / "etc" / "prefs.d" / f"{n}.js").is_file(),
    }
    bad = [problem for fid in ini.sections() for problem in feature_problems(ini, fid, exists)]
    if not ini.sections():
        bad.append("no features")
    if bad:
        raise BuildError("userinit/features.ini:\n  " + "\n  ".join(bad))


def feature_problems(ini, fid, exists):
    f = ini[fid]
    requires = f.get("requires", "").split()
    if not re.fullmatch(r"[a-z0-9-]+", fid):
        yield f"[{fid}]: an id is lowercase letters, digits and dashes"
    if not f.get("title") or not f.get("about"):
        yield f"[{fid}]: no title or about"
    if f.get("default") not in ("on", "off"):
        yield f"[{fid}] default: on or off"
    if f.get("dev", "no") not in ("yes", "no"):
        yield f"[{fid}] dev: yes or no"
    for key, ok in exists.items():
        for name in f.get(key, "").split():
            if not ok(name):
                yield f"[{fid}] {key}: there's no {name}"
    for name in requires:
        if name not in ini:
            yield f"[{fid}] requires: no feature {name}"
    # releases leave the dev features out
    if is_dev(f):
        if f.get("section"):
            yield f"[{fid}] section: releases leave out dev features, start the section on another one"
    else:
        for name in requires:
            if name in ini and is_dev(ini[name]):
                yield f"[{fid}] requires: {name} is a dev feature, releases leave it out"


def is_dev(feature):
    return feature.get("dev") == "yes"


def release_features(text):
    blocks = re.split(r"(?m)^(?=\[)", text)
    return "".join(b for b in blocks if not re.search(r"(?m)^dev *= *yes *$", b))
