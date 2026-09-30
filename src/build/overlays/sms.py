from ..edits import Overlay, Patch, insert_after, insert_before

MAIN_CSS = '<link rel="stylesheet" type="text/css" href="utils/style/main.css">\n'
HEAD = (
    '    <link rel="stylesheet" type="text/css" href="flipfull/messages.css">\n'
    '    <script src="flipfull/messages.js"></script>\n'
)
HEADER_ANCHOR = (
    "    // return time format by daydiff and yeardiff.\n"
    "    if (this.dayDiff === 0) {\n"
    "      return Utils.translateString('today');\n"
)

HEADER_DATE = (
    "    if (this.yearDiff < 1) {\n"
    "      return date.toLocaleString(this.dateLanguage, { month: 'short', day: 'numeric' });\n"
    "    }\n"
    "    return date.toLocaleString(this.dateLanguage, { month: 'short', day: 'numeric', year: 'numeric' });\n"
)
TIME = '<time data-time-update="true" data-time="${timestamp}"></time>'

OVERLAY = Overlay(edits=[
    *(insert_after(page, MAIN_CSS, HEAD) for page in ("index.html", "index_open.html", "index_bubble.html")),

    Patch("index.html", TIME, '<time data-time-update="true" data-time-only="true" data-time="${timestamp}"></time>'),
    insert_before("utils/js/time_utils.js", HEADER_ANCHOR, HEADER_DATE),
])
