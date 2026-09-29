"""userinit/etc/camera/profiles.xml: swaps into the phone's media_profiles*.xml."""

import xml.etree.ElementTree as ET

from .errors import BuildError
from .paths import ROOT, USERINIT

PROFILES = USERINIT / "etc" / "camera" / "profiles.xml"


# a section the phone can't parse leaves Gecko on its fallback profiles
def check_camera_profiles():
    where = PROFILES.relative_to(ROOT)
    try:
        root = ET.parse(PROFILES).getroot()
    except ET.ParseError as e:
        raise BuildError(f"{where}: {e}")
    if root.tag != "CamcorderProfiles" or root.get("cameraId") != "0":
        raise BuildError(f'{where}: should be one <CamcorderProfiles cameraId="0"> section')
