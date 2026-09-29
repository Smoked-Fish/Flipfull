"""No ads, and the song and play state for the outer screen (FlipfullNowPlaying)"""

from ..edits import Overlay, Rewrite, insert_after, insert_before
from ..snippets import FEATURES_SCRIPT, script
from ..textops import cut, remove_css_rules, remove_exact, remove_if_block, remove_span, replace_exact
from .ads import MANIFESTS, no_ads, no_ads_dependency

AD_STATES = '{NOT_INITIALIZED:"NOT_INITIALIZED",ERROR:"ERROR",LOADING:"LOADING",READY:"READY"}'


@no_ads
def music_bind(text):
    text = cut(text, "BannerAd={", "BannerAd", then=",")
    text = cut(text, "var RadioAd={", "RadioAd", then=";")
    text = cut(text, "function showFullscreenAd(){", "showFullscreenAd")
    text = remove_exact(text, f"const BANNER_AD_STATES={AD_STATES},FULL_COLLAPSE_ANIMATION_DURATION_MS=500;",
                        "banner states")
    text = remove_exact(text, f"const RADIO_AD_STATES={AD_STATES},RADIO_FULL_COLLAPSE_ANIMATION_DURATION_MS=500;",
                        "radio ad states")
    text = remove_exact(text, ',0<Number(window.localStorage.getItem("musicCount"))&&!BannerAd.initialized'
                        '&&BannerAd.init()', "banner start", count=2)
    text = remove_exact(text, ",RadioAd.initialized||RadioAd.init()", "radio ad start")
    text = replace_exact(text,
                         "if(this.anchor.lastChild)for(;!BannerAd.isBannerAdNode(this.anchor.lastChild);)"
                         "this.anchor.removeChild(this.anchor.lastChild)",
                         "for(;this.anchor.lastChild;)this.anchor.removeChild(this.anchor.lastChild)",
                         "song list clean-up")
    text = replace_exact(text,
                         "{if(RadioAd.isBannerAdNode(this.anchor.lastChild))return;"
                         "this.anchor.removeChild(this.anchor.lastChild)}",
                         "this.anchor.removeChild(this.anchor.lastChild)",
                         "radio list clean-up")
    text = replace_exact(text, "removeNodewithoutBanner", "removeAllNodes", "clean-up name", count=2)
    text = replace_exact(text, ",showFullscreenAd())", ")", "fullscreen ad at start")
    # without the SDK the app thinks it's the list-only version; make it the full one
    text = remove_exact(text, '"function"==typeof getKaiAd&&', "full version (list back key)")
    text = remove_exact(text, '"function"!=typeof getKaiAd||', "full version (start)")
    return text


@no_ads
def music_app(text):
    text = remove_exact(text, "    let isShowFullscreenAds = false;\n", "fullscreen ad flag")
    text = remove_exact(text,
                        "            if (!isShowFullscreenAds) {\n"
                        "                showFullscreenAd();\n"
                        "            }\n",
                        "fullscreen ad on return")
    text = replace_exact(text, "typeof getKaiAd === 'function' && e.key !== 'EndCall'",
                         "e.key !== 'EndCall'", "full version (overlay back key)")
    text = remove_if_block(text, "        if (typeof getKaiAd !== 'function' && document.hidden",
                           "list-only version block")
    return text


@no_ads
def music_index(text):
    text = remove_exact(text, script("js/ads/kaiads.v5.min.js", attrs=""), "SDK loader")
    for f in ("js/ui/banner_ad.js", "js/icecast/radio_ad.js"):
        text = remove_exact(text, f'    <!-- <script defer type="text/javascript" data-src="{f}"></script> -->\n', f)
    for prefix in ("", "i-"):
        text = remove_span(text,
                           f'            <div id="{prefix}banner-ad-placeholder">',
                           f'<div id="{prefix}banner-ad-container" tabindex="-1"></div>\n',
                           f"{prefix}banner placeholder markup")
    return text


@no_ads
def music_css(text):
    return remove_css_rules(text, "banner-ad", lambda n: n >= 3, "expected the banner styles")


NO_ADS = [
    Rewrite("js/bind.js", music_bind),
    Rewrite("js/music.js", music_app),
    Rewrite("index.html", music_index),
    Rewrite("style/main.css", music_css),
    Rewrite(MANIFESTS, no_ads_dependency),
]

NOW_PLAYING = [
    insert_after("index.html",
                 script("js/bind.js", attrs='defer="" type="text/javascript"'),
                 script("js/flipfull_now_playing.js", attrs='defer="" type="text/javascript"')),
    insert_after("js/communications.js",
                 "MusicComm.prototype.notifyMetadataChanged = function (metadata) {\n",
                 "    FlipfullNowPlaying.metadata(metadata);\n"),
    insert_after("js/communications.js",
                 "MusicComm.prototype.notifyStatusChanged = function (info) {\n",
                 "    FlipfullNowPlaying.status(info);\n"),
]

OVERLAY = Overlay(
    edits=[
        *NO_ADS,
        insert_before("index.html", "    <!-- Shared code -->\n", FEATURES_SCRIPT),
        *NOW_PLAYING,
    ],
    remove=[
        "js/ads/kaiads.v5.min.js", ".KaiAds.appinfo.json",
        "js/ui/banner_ad.js", "js/icecast/radio_ad.js",
        # unused
        "js/db.js", "js/ui/views/list_view.js",
        "js/ui/views/mainlist_view.js", "js/icecast/icecast_view.js",
    ],
)
