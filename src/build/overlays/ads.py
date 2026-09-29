import functools

from ..errors import PatchError
from ..textops import remove_exact

AD_WORDS = ("getKaiAd", "BannerAd", "RadioAd", "banner-ad", "FullscreenAd", "kaiads",
            "BANNER_AD", "RADIO_AD", "musicBannerAd", "radioBannerAd", "ads-sdk",
            "bannerAd", "fullscreenAd", "ads-fullscreen")

# one per language
MANIFESTS = "manifest*.webmanifest"


def no_ads(rewrite):
    @functools.wraps(rewrite)
    def checked(text):
        text = rewrite(text)
        left = [w for w in AD_WORDS if w in text]
        if left:
            raise PatchError(f"still mentions {', '.join(left)}")
        return text
    return checked


#todo multiple version fix
@no_ads
def no_ads_dependency(text):
    return remove_exact(text, ',"dependencies":{"ads-sdk":"1.4.5"}', "ads-sdk dependency")
