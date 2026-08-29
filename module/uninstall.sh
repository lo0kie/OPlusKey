#!/system/bin/sh
MODDIR=${0%/*}
PIDDIR="$MODDIR/run"
# 配置与 WebUI 调试日志都不在模块目录里，卸载时要单独清掉
PERSIST_DIR="/data/adb/OPlusKey"

mkdir -p "$PIDDIR" 2>/dev/null

# 先通知 service.sh 的看护循环退出，否则刚 pkill 就被重新拉起
touch "$PIDDIR/stop"

pkill -f "$MODDIR/bin/pluskeyd" 2>/dev/null

# 卸载即清干净。
# 更新模块不会执行本脚本（管理器只是替换模块目录），所以配置不会丢。
# 想卸载后留着配置（例如马上重装），卸载前执行：
#   su -c 'touch /data/adb/OPlusKey/.keep'
if [ -f "$PERSIST_DIR/.keep" ]; then
    rm -f "$PERSIST_DIR/webui-debug.log"
else
    rm -rf "$PERSIST_DIR"
fi

exit 0
