"""The home screen."""

from ..edits import Overlay, Patch, append, insert_after, prepend
from ..snippets import is_feature_on

BUNDLE = "dist/app.bundle.js"
STYLE = "dist/app.style.css"

HOME_SHORTCUTS = [
    insert_after(
        BUNDLE,
        'ee.default.getSettings().then(function(t){e.forceSettings=t,',
        is_feature_on("home-shortcuts") + '&&'
        '["home.customization.keypress","home.customization.longpress"].forEach(function(k){'
        'SettingsObserver.observe(k,null,function(v){e.forceSettings[k]=v})}),'),
    insert_after(
        BUNDLE,
        'key:"speedDial",value:function(e){var t=c.default.query("forceSettings"),n=t[y.default[3]];',
        'var f=' + is_feature_on("home-shortcuts") + '&&Array.isArray(n)&&n.find(function(s){'
        'return s.key===String(e)});if(f&&"voicemail"===f.type)return void this.dialVoicemail();'
        'if(f&&"none"===f.type)return;'),
]

KAIVA_IN_APP_LIST = [
    Patch(BUNDLE,
          f'if("{op}"===s.default.getBuildOperatorName()&&"kaios-voiceassistant"===e.name)return!0;',
          'if(!' + is_feature_on("kaiva") + f'&&"{op}"===s.default.getBuildOperatorName()&&'
          '"kaios-voiceassistant"===e.name)return!0;')
    for op in ("TF", "TMO")
]

SIDE_MENU_PLACES = 8


def side_menu_places_css(total):
    """The stock rules for a side menu of 6, for one of total, with the closed column scaled to fit."""
    item = f'.sidemenuItem[data-total="{total}"]'
    opened = f".panel-sidemenu--opened {item}"
    spacing = 26 / total
    css = (f"{item}{{--si-gap:.3rem;--si-size:5.6rem;--si-size_:4rem;--si-offset-x:.6rem;--si-opacity:1;--si-dir:1;"
           f"--si-scale:{(spacing - 0.3) / 5.6:.4f};"
           "--si-offset-y:calc((var(--si-size) * var(--si-scale) + var(--si-gap)) * var(--si-gap-count))}"
           f'{opened}[data-index="0"]{{--si-scale:1;--si-offset-x:1rem;--si-offset-y:0rem}}'
           f'{opened}[data-index^="-"]{{--si-dir:-1}}'
           f'{opened}[data-index*="1"]{{--si-scale:.89286;--si-offset-x:2rem;--si-offset-y:5.9rem}}'
           f'{opened}[data-index*="2"]{{--si-scale:.78571;--si-offset-x:4rem;--si-offset-y:10.8rem}}'
           f'{opened}[data-index*="3"]{{--si-scale:.64286;--si-offset-x:7rem;--si-offset-y:15rem}}'
           + ",".join(f'{opened}[data-index*="{i}"]' for i in range(3, 10)) + "{--si-opacity:0}"
           + ",".join(f'{opened}[data-index*="{i}"]' for i in range(4, 10))
           + "{--si-scale:.64286;--si-offset-x:11rem;--si-offset-y:18.8rem}")
    return css + "".join(f"{item}:nth-of-type({n + 1}){{--si-gap-count:{n - (total - 1) / 2:g}}}"
                         for n in range(total)) + "\n"


NO_SIDE_MENU_CLASS = "flipfull-no-side-menu"
HIDDEN_SIDE_MENU_CLASS = "flipfull-hidden-side-menu"
SIDE_MENU_SAVED = "flipfullSideMenu"
# Flip 3: the side menu shows only while open, and the home screen dims and moves further aside for it
HIDDEN_SIDE_MENU_CSS = (
    f".{HIDDEN_SIDE_MENU_CLASS} .Sidemenu{{opacity:0}}"
    f".{HIDDEN_SIDE_MENU_CLASS} .panel-sidemenu--opened .Sidemenu{{opacity:1}}"
    f".{HIDDEN_SIDE_MENU_CLASS} .app-workspace.panel-sidemenu--opened #main-view"
    "{opacity:.5;transform:translateX(17rem);transition-duration:.4s}\n")


def side_menu_look(look):
    """JS that sets the classes for look, an expression that is "off", "hidden" or ""."""
    return (f'(function(l){{document.documentElement.classList.toggle("{NO_SIDE_MENU_CLASS}","off"===l||"hidden"===l);'
            f'document.documentElement.classList.toggle("{HIDDEN_SIDE_MENU_CLASS}","hidden"===l)}})({look})')


SIDE_MENU = [
    insert_after(
        BUNDLE, 'n.generateItems=function(){',
        'if(n.flipfullApps){n.clearDefaultItemStatus();var f=[];'
        'n.flipfullOn&&n.flipfullApps.forEach(function(u,t){'
        'var e="default"===u?n.flipfullDefault(t):u?(0,L.findItemByProps)(AppStore.apps,{manifestUrl:u}):null;'
        'e&&f.indexOf(e)<0&&f.push(e)});'
        'f.forEach(function(e){e.isInSidemenu=!1}),n.setState({items:f}),n.entryIndex=0,'
        'n.isActive&&(0===f.length?n.exit():n.focusItem(Math.min(n.state.currentIndex,f.length-1)));return}'),
    Patch(BUNDLE,
          'emitter.on("getForceSettingsEnd",n.getForceSettingsEnd),n}',
          'emitter.on("getForceSettingsEnd",n.getForceSettingsEnd),' + is_feature_on("side-menu") + '&&('
          'n.flipfullOn=!0,n.flipfullHidden=!1,'
          # the stock choice for a place, as in the stock generateItems
          'n.flipfullDefault=function(t){var e=(R.length?R:I.firstCarouselApps)[t],'
          'i=e&&(0,L.findItemByProps)(AppStore.apps,e);'
          'return i||I.secondCarouselApps[t]&&(0,L.findItemByProps)(AppStore.apps,I.secondCarouselApps[t])},'
          'n.flipfullLook=function(){var l=n.flipfullOn?n.flipfullHidden?"hidden":"":"off";'
          + side_menu_look("l") + f';try{{localStorage.setItem("{SIDE_MENU_SAVED}",l)}}catch(e){{}}}},'
          '[["flipfull.sidemenu.enabled",function(v){n.flipfullOn=!1!==v,n.flipfullLook()}],'
          '["flipfull.sidemenu.hidden",function(v){n.flipfullHidden=!0===v,n.flipfullLook()}],'
          '["flipfull.sidemenu.apps",function(v){for(var a=[],t=0;t<' + str(SIDE_MENU_PLACES) + ';t++){'
          'var u=Array.isArray(v)?v[t]:void 0;a.push("string"==typeof u?u:t<4?"default":"")}n.flipfullApps=a}]]'
          '.forEach(function(k){SettingsObserver.observe(k[0],null,function(v){'
          'k[1](v),Array.isArray(AppStore.apps)&&n.generateItems()})})),n}'),
    prepend(BUNDLE, 'try{' + is_feature_on("side-menu") + '&&'
                    + side_menu_look(f'localStorage.getItem("{SIDE_MENU_SAVED}")') + '}catch(e){}\n'),
    append(STYLE, f"\n.{NO_SIDE_MENU_CLASS} .ClockComponent,"
                  f".{NO_SIDE_MENU_CLASS} #simcard-info{{margin-left:0}}\n" + HIDDEN_SIDE_MENU_CSS),
    # the stock styles place up to 6 icons; 7 and 8 get smaller ones so the column fits
    append(STYLE, "".join(side_menu_places_css(n) for n in range(7, SIDE_MENU_PLACES + 1))),
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

OVERLAY = Overlay(shows="restart", edits=[
    *HOME_SHORTCUTS,
    *KAIVA_IN_APP_LIST,
    *SIDE_MENU,
    *NO_FOLDERS,
    *CLOCK_SECONDS,
    *METRO_NAME,
])
