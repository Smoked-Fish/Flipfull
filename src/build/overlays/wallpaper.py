from ..edits import Overlay, Patch

OVERLAY = Overlay(
    edits=[
        Patch("js/pick.js",
              "this.returnResult(!1,{type:e.type,blob:e,name:t,filename:t})",
              "this.returnResult(!1,{type:e.type,blob:e,name:t,"
              "filename:/\\.(mp4|gif|webp)$/i.test(t)?t.split(\"/\").pop():t})"),
    ],
    stock_md5="a0499ffb65d077bc3263f4b16b687692",
)
