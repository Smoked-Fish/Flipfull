#entry
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib/common.sh"
. "$HERE/needs/app.sh"
. "$HERE/lib/store.sh"
cmd_store "$@"