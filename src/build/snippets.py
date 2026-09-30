def is_feature_on(feature):
    return f'!!(window.FlipfullFeatures&&FlipfullFeatures["{feature}"])'


def script(src, attrs='defer=""'):
    return f'    <script {attrs} src="{src}"></script>\n' if attrs else f'    <script src="{src}"></script>\n'


# features.js, written on the phone, sets window.FlipfullFeatures
FEATURES_SCRIPT = script("http://127.0.0.1/flipfull/features.js", attrs="")
APP_ORIGIN_SCRIPT = script("http://shared.localhost/js/utils/common/app_origin.js", attrs="")


def look_head(app):
    return ('    <link rel="stylesheet" href="http://shared.localhost/flipfull/look.css">\n'
            f'    <link rel="stylesheet" href="flipfull/{app}.css">\n'
            + FEATURES_SCRIPT + script("http://shared.localhost/flipfull/look.js", attrs="")
            + script(f"flipfull/{app}.js", attrs=""))


def look_px(name, stock):
    return f'(window.FlipfullLook?FlipfullLook.px("{name}",{stock}):{stock})'
