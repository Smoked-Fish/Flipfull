from ..edits import Overlay, Patch, insert_after, insert_before
from ..snippets import is_feature_on, look_head

ON = is_feature_on("email-redesign")

APPEARANCE_KEY = "{ name: 'Appearance', priority: %d, method: () => FlipfullLook.open() }"

OVERLAY = Overlay(edits=[
    insert_after("index.html",
                 '  <link rel="stylesheet" type="text/css" href="http://shared.localhost/style/gaia_icons/gaia-icons.css">\n',
                 look_head("email")),
    insert_before("js/cards/welcome_page.js",
                  "                NavigationMap.setSoftKeyBar(menuOptions);\n",
                  f"                if ({ON}) {{\n"
                  f"                    menuOptions.unshift({APPEARANCE_KEY % 1});\n"
                  "                }\n"),
    Patch("js/cards/settings_main.js",
          "                {\n"
          "                    name: 'Select',\n"
          "                    l10nId: 'select',\n"
          "                    priority: 2\n"
          "                }\n"
          "            ],\n",
          "                {\n"
          "                    name: 'Select',\n"
          "                    l10nId: 'select',\n"
          "                    priority: 2\n"
          "                },\n"
          f"                ...({ON} ? [{APPEARANCE_KEY % 3}] : [])\n"
          "            ],\n"),
])
