"""Contacts: the look from Messages (src/overlays/contact/flipfull/), and no sync popups."""

from ..edits import Overlay, Patch, insert_after
from ..snippets import is_feature_on, look_head

BUNDLE = "dist/bundle.js"
SYNC_POPUPS = is_feature_on("contacts-no-sync-popup")

# after a sync: "All contacts are synced."
SYNCED_TOAST = 'Array.isArray(e)&&!e.length||s.a.request("ToastManager:show",{text:_("all-contacts-synced")})'
CLOSE_ASKS_BACK = 'u.a.query("isSyncingContacts")&&(u.a.request("showDialog",{type:"confirm"'
CLOSE_ASKS_END_CALL = '"EndCall"===e.key&&(u.a.query("isSyncingContacts")?'

OVERLAY = Overlay(edits=[
    insert_after("index.html", '<link rel="stylesheet" href="dist/bundle.css">\n', look_head("contacts")),
    Patch(BUNDLE, SYNCED_TOAST, SYNC_POPUPS + "||" + SYNCED_TOAST),
    Patch(BUNDLE, CLOSE_ASKS_BACK, "!" + SYNC_POPUPS + "&&" + CLOSE_ASKS_BACK),
    Patch(BUNDLE, CLOSE_ASKS_END_CALL, '"EndCall"===e.key&&(!' + SYNC_POPUPS + '&&u.a.query("isSyncingContacts")?'),
])
