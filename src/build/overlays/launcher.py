"""The home screen."""

from ..edits import Overlay, Patch, append, insert_after, insert_before, prepend
from ..snippets import FEATURES_SCRIPT, is_feature_on, script

BUNDLE = "dist/app.bundle.js"
STYLE = "dist/app.style.css"

HOME_SHORTCUTS = [
    insert_after(
        BUNDLE,
        'ee.default.getSettings().then(function(t){e.forceSettings=t,',
        is_feature_on("home-shortcuts") + '&&'
        '["home.customization.keypress","home.customization.longpress"].forEach(function(k){'
        'SettingsObserver.observe(k,null,function(v){e.forceSettings[k]=v})}),'),
]

KAIVA_IN_APP_LIST = [
    Patch(BUNDLE,
          f'if("{op}"===s.default.getBuildOperatorName()&&"kaios-voiceassistant"===e.name)return!0;',
          'if(!' + is_feature_on("kaiva") + f'&&"{op}"===s.default.getBuildOperatorName()&&'
          '"kaios-voiceassistant"===e.name)return!0;')
    for op in ("TF", "TMO")
]

NO_SIDE_MENU_CLASS = "flipfull-no-side-menu"
SIDE_MENU = 'c.default.createElement(I.default,{ref:function(t){e.panels.sidemenu=t}})'
NO_SIDE_MENU = [
    Patch(BUNDLE, SIDE_MENU, is_feature_on("no-side-menu") + '?null:' + SIDE_MENU),
    Patch(BUNDLE,
          'case"ArrowLeft":"T435V"!==N.default.getBuildCodeName()&&',
          'case"ArrowLeft":!' + is_feature_on("no-side-menu") + '&&"T435V"!==N.default.getBuildCodeName()&&'),
    # the class centers the clock and the carrier name
    prepend(BUNDLE, f'document.documentElement.classList.toggle("{NO_SIDE_MENU_CLASS}",'
                    + is_feature_on("no-side-menu") + ");"),
    append(STYLE, f"\n.{NO_SIDE_MENU_CLASS} .ClockComponent,"
                  f".{NO_SIDE_MENU_CLASS} #simcard-info{{margin-left:0}}\n"),
]

NO_FOLDERS = [
    Patch(BUNDLE,
          'X=X.concat(JSON.parse(i)||(n<=256?[]:r))',
          'X=X.concat(' + is_feature_on("no-folders") + '?(localStorage.setItem("flipfullNoFolders","1"),'
          '(JSON.parse(i)||(n<=256?[]:r)).filter(function(e){'
          'return"games"!==e.basisname&&"utilities"!==e.basisname})):'
          'function(s,d){if(s&&localStorage.getItem("flipfullNoFolders")){'
          'd.forEach(function(f){s.some(function(e){return e.basisname===f.basisname})||s.push(f)});'
          'localStorage.removeItem("flipfullNoFolders")}return s||d}(JSON.parse(i),n<=256?[]:r))'),
    Patch(BUNDLE,
          'J=256===n?["Carrier"]:["Games","Carrier","Utilities"]',
          'J=256===n||' + is_feature_on("no-folders") + '?["Carrier"]:["Games","Carrier","Utilities"]'),
]

AMPM = 'p.default.createElement("div",{className:"clock-ampm","data-hour-24":!window.api.hour12},this.state.ampm)'
CLOCK_SECONDS_CSS = (
    ".flipfull-clock-side{display:flex;flex-direction:column;justify-content:flex-end;"
    "margin-inline-start:.3rem;margin-bottom:.3rem}"
    ".flipfull-clock-side .clock-ampm{align-self:flex-start;margin:0;line-height:1.6rem}"
    ".flipfull-clock-seconds{font-size:2.2rem;line-height:2.4rem;font-weight:400}")
CLOCK_SECONDS = [
    Patch(BUNDLE,
          'this.timer=setTimeout(function(){e.start()},1e3*(60-t.getSeconds()))',
          'this.timer=setTimeout(function(){e.start()},' + is_feature_on("clock-seconds")
          + '?1020-t.getMilliseconds():1e3*(60-t.getSeconds()))'),
    Patch(BUNDLE, 'm2:d[1],ampm:c})', 'm2:d[1],ampm:c,flipfullSeconds:("0"+e.getSeconds()).slice(-2)})'),
    Patch(BUNDLE, AMPM,
          is_feature_on("clock-seconds") + '?p.default.createElement("div",{className:"flipfull-clock-side"},'
          + AMPM + ','
          'p.default.createElement("div",{className:"flipfull-clock-seconds"},this.state.flipfullSeconds))'
          ':' + AMPM),
    append(STYLE, CLOCK_SECONDS_CSS + "\n"),
]

METRO_NAME = [
    Patch(BUNDLE,
          'n.push({signalLevel:s,carrierName:u,stateL10nId:l,isVoWifi:h})',
          'n.push({signalLevel:s,carrierName:' + is_feature_on("metro-name")
          + '&&"string"==typeof u?u.replace(/Metro by T-Mobile/gi,"Metro"):u,stateL10nId:l,isVoWifi:h})'),
]

OVERLAY = Overlay(edits=[
    insert_before("index.html", script("js/debug_helper.js", attrs=""), FEATURES_SCRIPT),
    *HOME_SHORTCUTS,
    *KAIVA_IN_APP_LIST,
    *NO_SIDE_MENU,
    *NO_FOLDERS,
    *CLOCK_SECONDS,
    *METRO_NAME,
])
