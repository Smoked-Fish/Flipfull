from ..edits import Overlay, Patch, Rewrite, insert_before
from ..snippets import FEATURES_SCRIPT, is_feature_on, script
from ..textops import cut, remove_css_rules, remove_exact, replace_exact
from .ads import MANIFESTS, no_ads, no_ads_dependency


@no_ads
def video_index(text):
    for f in ("js/ads/kaiads.v5.min.js", "js/ads/fullscreen.js"):
        text = remove_exact(text, script(f), f)
    return remove_exact(text, '          <div class="banner-ad-placeholder" id="banner-ad-placeholder"></div>\n',
                        "banner placeholder")


@no_ads
def video_app(text):
    text = remove_exact(text, "!document.hidden&&fullscreenAd.isEnabled&&fullscreenAd.show(),",
                        "fullscreen ad on return")
    text = remove_exact(text, "e!==LAYOUT_MODE.list||fullscreenAd.isDisplaying||(fullscreenAd.isEnabled=!0);",
                        "fullscreen ad re-armed in the list")
    text = replace_exact(text, "function thumbnailClickHandler(e){fullscreenAd.isDisplaying||(",
                         "function thumbnailClickHandler(e){(", "no clicks under the fullscreen ad")
    return remove_exact(text, "fullscreenAd.isEnabled=!1,", "fullscreen ad off while playing")


@no_ads
def video_navigation(text):
    text = remove_exact(text,
                        "  var optClickBannerAd = {\n"
                        "    name: 'Go',\n"
                        "    l10nId: 'go',\n"
                        "    priority: 2,\n"
                        "    method: () => thumbnailList.bannerAd.call('click')\n"
                        "  };\n\n",
                        "banner Go key")
    text = remove_exact(text, "  var actBannerAd = [optTakeVideo, optClickBannerAd];\n", "banner keys")
    text = remove_exact(text,
                        "    if (thumbnailList.fullscreenAd) {\n"
                        "      return;\n"
                        "    }\n",
                        "keys ignored under the fullscreen ad")
    text = remove_exact(text, "        setTimeout(() => thumbnailList.getBannerAd(), 0);\n", "banner load")
    text = remove_exact(text,
                        "          else if (thumbnailList.adContainer &&\n"
                        "            thumbnailList.adContainer.classList.contains('focus') &&\n"
                        "            thumbnailList.adReady === true) {\n"
                        "            skbParams.items = actBannerAd;\n"
                        "          }\n",
                        "banner keys when focused")
    return replace_exact(text,
                         "      if (!fullscreenAd.isDisplaying) {\n"
                         "        exports.option.show();\n"
                         "      }\n",
                         "      exports.option.show();\n",
                         "softkeys hidden under the fullscreen ad")


@no_ads
def video_thumbnails(text):
    text = replace_exact(text, ",this.bannerAdPlaceholder=null,this.bannerAd=null,this.adContainer=null,"
                         "this.adReady=!1,this.fullscreenAd=!1}", "}", "banner fields")
    return cut(text, ",ThumbnailList.prototype.getBannerAd=function(){", "getBannerAd")


@no_ads
def video_css(text):
    return remove_css_rules(text, "banner-ad|ads-fullscreen", lambda n: n == 7, "expected the 7 ad styles")


NO_ADS = [
    Rewrite("index.html", video_index),
    Rewrite("js/video.js", video_app),
    Rewrite("js/navigation_map.js", video_navigation),
    Rewrite("js/thumbnail_list.js", video_thumbnails),
    Rewrite("style/video.css", video_css),
    Rewrite(MANIFESTS, no_ads_dependency),
]

# the stock app shows its YouTube picks only with the ads SDK loaded
NO_YOUTUBE = [
    Patch("js/video_utils.js",
          'supportKaiAds:"function"==typeof getKaiAd,',
          'supportKaiAds:!' + is_feature_on("video-no-youtube") + ','),
]

OVERLAY = Overlay(
    edits=[
        *NO_ADS,
        insert_before("index.html", script("http://shared.localhost/js/utils/l10n/l10n.js"), FEATURES_SCRIPT),
        *NO_YOUTUBE,
    ],
    remove=["js/ads/kaiads.v5.min.js", "js/ads/fullscreen.js", ".KaiAds.appinfo.json"],
)
