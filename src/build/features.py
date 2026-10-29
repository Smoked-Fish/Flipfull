import configparser
import functools
import re

from .edits import BuildError
from .paths import USERINIT

FEATURES = USERINIT / "features.ini"
SERVICES = USERINIT / "remote" / "services.ini"
STEPS = USERINIT / "steps"
KEYS = {"title", "section", "about", "default", "dev", "requires", "ask-off"}


@functools.cache
def features():
    ini = configparser.ConfigParser(interpolation=None)
    ini.read(FEATURES, encoding="utf-8")
    return ini


def check_features(overlays, apps):
    ini = features()
    remote = configparser.ConfigParser(interpolation=None)
    remote.read(SERVICES, encoding="utf-8")
    needs = {
        "overlays": lambda n: n in overlays,
        "apps": lambda n: n in apps,
        "services": lambda n: (USERINIT / "services" / n / "service.sh").is_file(),
        "hosts": lambda n: (USERINIT / "etc" / "hosts.d" / f"{n}.hosts").is_file(),
        "prefs": lambda n: (USERINIT / "etc" / "prefs.d" / f"{n}.js").is_file(),
        "autoconfig": lambda n: (USERINIT / "etc" / "autoconfig.d" / f"{n}.js").is_file(),
        "steps": lambda n: any(STEPS.glob(f"*/{n}.sh")),
    }
    bad = [problem for fid in ini.sections() for problem in feature_problems(ini, fid, needs)]
    bad += admits_problems(ini, remote)
    if not ini.sections():
        bad.append("no features")
    if bad:
        raise BuildError("userinit/features.ini:\n  " + "\n  ".join(bad))


def feature_problems(ini, fid, needs):
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
    for key in f:
        if key not in KEYS and key not in needs:
            yield f"[{fid}] {key}: not a key; needs are {', '.join(needs)}"
    for key, ok in needs.items():
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


def admits_problems(ini, remote):
    for name in remote.sections():
        for pair in remote[name].get("admits", "").split(","):
            feature = pair.split()[-1] if pair.split() else ""
            if feature != "always" and not ini.has_section(feature):
                yield f"userinit/remote/services.ini [{name}] admits: there's no feature {feature}"


def check_feature_reads(overlay, reads):
    ini = features()
    bad = [f"{overlay} reads feature {fid}, which isn't in userinit/features.ini" for fid in sorted(reads)
           if not ini.has_section(fid)]
    bad += [f"{overlay} reads feature {fid}, so [{fid}] needs overlays = {overlay}" for fid in sorted(reads)
            if ini.has_section(fid) and overlay not in ini[fid].get("overlays", "").split()]
    if bad:
        raise BuildError("\n  ".join(bad))


def is_dev(feature):
    return feature.get("dev") == "yes"


def release_features(text):
    blocks = re.split(r"(?m)^(?=\[)", text)
    return "".join(b for b in blocks if not re.search(r"(?m)^dev *= *yes *$", b))
