"""keys, volume, notifications, updates, sign-in, and the outer screen"""

from ..edits import Overlay, Patch, append, insert_after, insert_before
from ..paths import OVERLAY_SRC
from ..snippets import APP_ORIGIN_SCRIPT, FEATURES_SCRIPT, is_feature_on, script

BUNDLE = "dist/app.bundle.js"
REMOTE_BUNDLE = "remote/dist/app.bundle.js"
BUTTONS_JS = "js/hardware_buttons.js"
SOUND_JS = "js/sound_manager.js"
DIALER_JS = "js/dialer_agent.js"

# without it the start-up logo stays the carrier, work on later
INITLOGO = OVERLAY_SRC / "system" / "resources" / "branding" / "initlogo_flipfull.png"

SYSTEM_SCRIPTS = script("js/live_wallpaper.js") + script("js/flipfull_system.js")
MAPS_SCRIPT = script("js/flipfull_maps.js")  # WIP (doesn't work right rn)
SCRIPTS = [
    insert_before("index.html", script("js/remote_helper.js"), FEATURES_SCRIPT),
    insert_before("index_remote.html", APP_ORIGIN_SCRIPT, FEATURES_SCRIPT),
    insert_after("index.html", script("js/external_screen_manager.js"), SYSTEM_SCRIPTS + MAPS_SCRIPT),
    insert_after("index_remote.html", script("remote/dist/app.bundle.js"), SYSTEM_SCRIPTS),
]

GOOGLE_CLIENT = """
window.FlipfullGoogleClient = (function(google) {
  const FILE = '/data/local/userinit/config/google-client.json';
  const stock = { client_id: google.client_id, client_secret: google.client_secret };
  let own = null;
  ['client_id', 'client_secret'].forEach(key => Object.defineProperty(google, key, {
    get: () => (own || stock)[key],
    enumerable: true
  }));
  function load() {
    if (!(window.FlipfullFeatures && window.FlipfullFeatures['google-accounts'])) {
      own = null;
      return Promise.resolve();
    }
    return IOUtils.readJSON(FILE).then(json => {
      own = { client_id: json.web.client_id, client_secret: json.web.client_secret };
    }, () => {
      own = null;
    });
  }
  load();
  return { load };
}(Oauth2Config.google));
"""
GOOGLE_ACCOUNTS = [
    append("js/account_manager/oauth2_config.js", GOOGLE_CLIENT),
    insert_before("js/account_manager/google_authenticator.js",
                  "    const codeChallenge = await getChallenge();\n",
                  "    await FlipfullGoogleClient.load();\n"),
]

EVENT_LOGGER_START = (
    'SettingsObserver.observe("metrics.type",null,function e(t){if("jio"===t)'
    'LazyLoader.load(["../js/app_usage_data.js","../js/app_usage_metrics.js","../js/telemetry.js"],'
    '()=>{window.appUsageMetrics=new AppUsageMetrics,window.appUsageMetrics.start(),new Ps,'
    'window.isJioApplication=!0});else{const e=new Cs;e.start(),window.evlm=e}'
    'SettingsObserver.unobserve("metrics.type",e)});')
BLOCK_TELEMETRY = [
    insert_before(BUNDLE, EVENT_LOGGER_START, is_feature_on("block-telemetry") + "||"),
]

BLOCK_UPDATES = [
    Patch("js/fota/fotaJs_Loader.js",
          "\nfotaLoader.init();\n",
          "\n" + is_feature_on("block-updates") + "||fotaLoader.init();\n"),
]

HARDWARE_BUTTONS = [
    # track-skip
    Patch(BUTTONS_JS,
          '.prototype.repeat=function(){this.repeating=!0,this.repeatCount++,',
          '.prototype.repeat=function(){if(!this.repeating&&window.FlipfullMedia&&'
          'window.FlipfullMedia.hold(this.direction))return void(this.repeating=!0);'
          'this.repeating=!0,this.repeatCount++,'),
    # volume-keys
    Patch(BUTTONS_JS,
          'turnscreenOnHandle=function(e){this.browserKeyEventManager.screenOff()&&('
          '"qd-call-button-press"!==this.browserKeyEventManager.getButtonEventType(e)&&(',
          'turnscreenOnHandle=function(e){(this.flipfullScreenWasOff=this.browserKeyEventManager.screenOff())&&('
          '"qd-call-button-press"!==this.browserKeyEventManager.getButtonEventType(e)&&'
          '!(window.FlipfullMedia&&FlipfullMedia.passKey(e))&&('),
    Patch(BUTTONS_JS,
          'if(this.qdProcess(e,s),this.browserKeyEventManager.screenOff())return',
          'if(this.qdProcess(e,s),this.browserKeyEventManager.screenOff()&&'
          '!(window.FlipfullMedia&&FlipfullMedia.passKey(e)))return'),
    # play-pause-button
    Patch(BUTTONS_JS,
          'if(clearTimeout(this.qdTimer),this.qdCount++,this.qdTimer=setTimeout(()=>{var e;',
          'if(clearTimeout(this.qdTimer),this.qdCount++||window.FlipfullMedia&&'
          'FlipfullMedia.quickPress(this.flipfullScreenWasOff,this._isCalling),'
          'this.qdTimer=setTimeout(()=>{var e;window.FlipfullMedia&&FlipfullMedia.quickPresses(this.qdCount);'),
]

NO_BATTERY_FULL = [
    insert_after("js/battery_overlay.js",
                 "    shouldNotifyBatteryFull: function() {\n",
                 "      if (" + is_feature_on("no-battery-full") + ") {\n"
                 "        return false;\n"
                 "      }\n"),
]

OUTER_SCREEN_TIMEOUT = [
    Patch(REMOTE_BUNDLE,
          ',this._timerID=window.setTimeout(function(){!t.state.lidOpen&&t.attentionScreen.state.show',
          ',this._timerID=null,window.FlipfullOuterScreen&&FlipfullOuterScreen.stayOn()||'
          '(this._timerID=window.setTimeout(function(){!t.state.lidOpen&&t.attentionScreen.state.show'),
    Patch(REMOTE_BUNDLE,
          't._timerID=null},this.state.timeout)}},{key:"setOffTimeout"',
          't._timerID=null},window.FlipfullOuterScreen?FlipfullOuterScreen.dimAfter(this.state.timeout,'
          'this.props.timeout):this.state.timeout))}},{key:"setOffTimeout"'),
]

ALERT_VOLUME = [
    Patch(SOUND_JS,
          'l.MAX_VOLUME={alarm:11,notification:11,telephony:8,content:11,bt_sco:11}',
          'l.MAX_VOLUME={alarm:11,notification:11,telephony:8,content:11,bt_sco:11,alerts:11}'),
    Patch(SOUND_JS,
          'l.prototype.cachedChannels=["content","notification"]',
          'l.prototype.cachedChannels=["content","notification",...('
          + is_feature_on("alert-volume") + '?["alerts"]:[])]'),
    Patch(SOUND_JS,
          'l.prototype.currentVolume={alarm:10,notification:10,telephony:10,content:10,bt_sco:10}',
          'l.prototype.currentVolume={alarm:10,notification:10,telephony:10,content:10,bt_sco:10,...('
          + is_feature_on("alert-volume") + '?{alerts:10}:{})}'),
    insert_after(DIALER_JS,
                 't.prototype._startAlerting=function(e){this._alerting=!0,',
                 'window.FlipfullVolume&&FlipfullVolume.ringing(!0),'),
    insert_after(DIALER_JS,
                 't.prototype._stopAlerting=function(){var e=this._player;this._alerting=!1,',
                 'window.FlipfullVolume&&FlipfullVolume.ringing(!1),'),
]

VOLUME_SLIDERS = [
    Patch(BUNDLE,
          'Ut(this,"modules",[Nt,Pt,_t,Rt,St,Mt,Dt,Ct])',
          'Ut(this,"modules",[Nt,Pt,_t,Rt,St,Mt,Dt,...(window.FlipfullVolume?FlipfullVolume.sliders(Dt):[]),Ct])'),
    Patch(BUNDLE,
          'notification:"is-volume-type-notification"}',
          'notification:' + is_feature_on("alert-volume")
          + '?"ringtones":"is-volume-type-notification",alerts:"Alerts"}'),
    Patch(BUNDLE,
          'Ot(this,"updateValue",()=>{let e=soundManager.getChannel(),',
          'Ot(this,"updateValue",()=>{let e=this.channel(),'),
    Patch(BUNDLE,
          'case"Enter":"notification"===soundManager.getChannel()?',
          'case"Enter":"notification"===this.channel()?'),
    Patch(BUNDLE,
          ':"content"===soundManager.getChannel()&&(this.config.value?soundManager.enterSilentMode("content")'
          ':soundManager.leaveSilentMode("content"))',
          ':["content","alerts"].includes(this.channel())'
          '&&(this.config.value?soundManager.enterSilentMode(this.channel())'
          ':soundManager.leaveSilentMode(this.channel()))'),
    Patch(BUNDLE,
          't&&soundManager.changeVolume(t)}getChannelL10n(e=soundManager.getChannel()){',
          't&&soundManager.changeVolume(t,this.channel())}channel(){return soundManager.getChannel()}'
          'getChannelL10n(e=this.channel()){'),
    # the sliders all have the name volume
    Patch(BUNDLE, 'key:e.name,className:n,tabIndex:"-1"', 'key:e.name+e.title,className:n,tabIndex:"-1"'),
]

BOOT_LOGO = [
    Patch("js/init_logo_handler.js",
          'CustomLogoPath.oslogo.image="tmo"===e?',
          'CustomLogoPath.oslogo.image=' + is_feature_on("boot-logo")
          + '?"file:///system/media/initlogo.png":"tmo"===e?'),
] if INITLOGO.is_file() else []

OVERLAY = Overlay(edits=[
    *SCRIPTS,
    *GOOGLE_ACCOUNTS,
    *BLOCK_TELEMETRY,
    *BLOCK_UPDATES,
    *HARDWARE_BUTTONS,
    *NO_BATTERY_FULL,
    *OUTER_SCREEN_TIMEOUT,
    *ALERT_VOLUME,
    *VOLUME_SLIDERS,
    *BOOT_LOGO,
])
