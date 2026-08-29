#!/system/bin/sh
MODDIR=${0%/*}
pkill -f "$MODDIR/bin/pluskeyd" 2>/dev/null
exit 0
