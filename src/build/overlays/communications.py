from ..edits import Overlay, Patch, insert_after
from ..snippets import is_feature_on, look_head, look_px

LIST = "dist/3.js"
ON = is_feature_on("call-log-redesign")

ROW_HEIGHTS = "this.ITEM_HEIGHT=62,this.GROUNPHEADHEIGHT=22,this.CACHE_NUMBER=5,"

OPTIONS = 'n({openOptionMenu:!0,options:a})'
APPEARANCE = '{label:"Appearance",callback:()=>{%s({openOptionMenu:!1}),FlipfullLook.open()}}'
NO_CALLS_KEYS = 't):{left:"contacts"}})'
NO_CALLS_OPTIONS = 't&&this.list.showOptionMenu(t,s,a)}'

OVERLAY = Overlay(edits=[
    insert_after("index.html", '<link href="dist/styles.css" rel="stylesheet">', "\n" + look_head("call-log")),
    Patch(LIST, ROW_HEIGHTS,
          f'this.ITEM_HEIGHT={look_px("--ff-item", 62)},this.GROUNPHEADHEIGHT={look_px("--ff-group", 22)},'
          f'this.CACHE_NUMBER={ON}?12:5,'),
    Patch(LIST, OPTIONS, f'n({{openOptionMenu:!0,options:a.concat({ON}?[{APPEARANCE % "n"}]:[])}})'),
    Patch(LIST, NO_CALLS_KEYS, f't):{ON}?{{left:"contacts",right:"options"}}:{{left:"contacts"}}}})'),
    Patch(LIST, NO_CALLS_OPTIONS,
          f't?this.list.showOptionMenu(t,s,a):{ON}&&this.props.showOptionMenu({{openOptionMenu:!0,'
          f'options:[{APPEARANCE % "this.props.showOptionMenu"}]}})}}'),
])
