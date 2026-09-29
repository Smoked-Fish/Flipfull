from ..edits import Overlay, Patch, insert_after, insert_before
from ..snippets import APP_ORIGIN_SCRIPT, FEATURES_SCRIPT, is_feature_on

LIST_ELEMENTS = "        listElements = panel.querySelectorAll('li');\n"


def hide_unless(selector, feature, parent=False):
    """Hides a settings entry while its feature is off."""
    node = f"panel.querySelector('{selector}')" + (".parentNode" if parent else "")
    return f"        {node}.classList.toggle('hidden', !" + is_feature_on(feature) + ");\n"


#ugly
DISPLAY_ITEM = ('              <a id="menuItem-display" class="menu-item" href="#display" '
                'data-l10n-id="display">Display</a>\n            </li>\n')

HOME_SHORTCUTS_ITEM = ('            <li role="menuitem">\n'
                       '              <a id="menuItem-homeShortcuts" class="menu-item" '
                       'href="#home_shortcuts">Home Screen Shortcuts</a>\n'
                       '            </li>\n')
HOME_SHORTCUTS = [
    insert_after("index.html", DISPLAY_ITEM, HOME_SHORTCUTS_ITEM),
    insert_after("js/panels/root/panel.js", "        RootManager.init();\n",
                 hide_unless("#menuItem-homeShortcuts", "home-shortcuts", parent=True)),
]

ASSISTED_DIALING_ITEM = "        <li role=\"menuitem\" id='menuItem-assisted-dialing' class=\"hidden\">\n"
CALL_RECORDING_ITEM = (
    '        <li role="menuitem" id="call-recording-item">\n'
    '          <a class="menu-item">\n'
    '            <span>Call Recording</span>\n'
    '          </a>\n'
    '        </li>\n\n')
CALL_RECORDING = [
    insert_before("elements/call.html", ASSISTED_DIALING_ITEM, CALL_RECORDING_ITEM),
    insert_after("js/panels/call/panel.js",
                 "      'menuItem-assisted-dialing': '#assisted_dialing',\n",
                 "      'call-recording-item': '#call_recording',\n"),
    insert_before("js/panels/call/panel.js", LIST_ELEMENTS,
                  hide_unless("#call-recording-item", "call-recording")),
]

NETWORK_TYPE_HIDING = (
    "        elements.networkType.classList.add('hidden');\n"
    "        SettingsObserver.getValue('hidemenu.networkType.temp').then((result) => {\n"
    "          DebugHelper.log('hidemenu.networkType.temp = ' + result);\n"
    "          if (result == 1) {\n"
    "            elements.networkType.classList.remove('hidden');\n"
    "          } else {\n"
    "            elements.networkType.classList.add('hidden');\n"
    "          }\n"
    "        }).catch((error) => {\n"
    "          DebugHelper.log('Error getting the value: ' + error);\n"
    "          elements.networkType.classList.add('hidden');\n"
    "        });\n")
NETWORK_TYPE = [
    Patch("js/panels/carrier_detail/panel.js", NETWORK_TYPE_HIDING,
          "        if (" + is_feature_on("network-type") + ") {\n"
          "          elements.networkType.classList.remove('hidden');\n"
          "        } else {\n" + NETWORK_TYPE_HIDING + "        }\n"),
]

AUTO_LOCK_ITEM = '        <li role="menuitem" id="auto-lock" class="auto-height hidden">\n'
SUBSCREEN_TIMEOUTS = [(15, "fifteen-seconds"), (30, "thirty-seconds"), (60, "one-minute"),
                      (120, "two-minutes"), (300, "five-minutes"), (600, "ten-minutes"), (0, "never")]
SUBSCREEN_TIMEOUT_ITEM = (
    '        <li role="menuitem" id="flipfull-subscreen-timeout">\n'
    '          <span>Sub-screen timeout</span>\n'
    '          <div class="button icon icon-dialog">\n'
    '            <select data-name="flipfull.subscreen.timeout" data-value-type="integer">\n'
    '              <option value="10">10 seconds</option>\n'
    + "".join(f'              <option value="{v}" data-l10n-id="{l10n}"></option>\n'
              for v, l10n in SUBSCREEN_TIMEOUTS) +
    '            </select>\n'
    '          </div>\n'
    '        </li>\n')
OUTER_SCREEN_TIMEOUT = [
    insert_before("elements/display.html", AUTO_LOCK_ITEM, SUBSCREEN_TIMEOUT_ITEM),
    insert_before("js/panels/display/panel.js", LIST_ELEMENTS,
                  hide_unless("#flipfull-subscreen-timeout", "outer-screen-timeout")),
]

OVERLAY = Overlay(edits=[
    insert_before("index.html", APP_ORIGIN_SCRIPT, FEATURES_SCRIPT),
    *HOME_SHORTCUTS,
    *CALL_RECORDING,
    *NETWORK_TYPE,
    *OUTER_SCREEN_TIMEOUT,
])
