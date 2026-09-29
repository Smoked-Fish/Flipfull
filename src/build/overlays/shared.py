from ..edits import Overlay, Patch

OVERLAY = Overlay(
    edits=[
        # GIFs keep their animation instead of coming back as the unresized original's still
        Patch("js/utils/media/image_utils.js",
              "return t===g&&r===u?o:n(e)",
              "return t===g&&r===u&&e.type!==a.GIF?o:n(e)"),
    ],
    stock_md5="8aba4d99da9c602cfe76eb22c041eafd",
)
