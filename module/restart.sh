#!/data/data/com.termux/files/usr/bin/bash

MODDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DAEMON="$MODDIR/bin/pluskeyd"
LOG="$MODDIR/pluskey.log"

# 权限自修（部分管理器解压不保留权限位）
chmod 755 "$DAEMON" 2>/dev/null

echo "=============================================="
echo "       OnePlus 15 Plus Key 重启服务"
echo "=============================================="

if [ "$(id -u)" != "0" ]; then
    echo "[ERROR] 必须 root"
    exit 1
fi

echo "[1/5] 清理所有 pluskeyd"

pkill -9 -x pluskeyd 2>/dev/null || true

sleep 1

if pgrep -x pluskeyd >/dev/null 2>&1; then
    echo "[ERROR] 无法停止旧 pluskeyd"
    pgrep -a -x pluskeyd
    exit 1
fi

echo "[OK] 所有旧进程已停止"

echo
echo "[2/5] 检查 daemon"

if [ ! -x "$DAEMON" ]; then
    echo "[ERROR] daemon 不存在或不可执行："
    echo "$DAEMON"
    exit 1
fi

ls -lh "$DAEMON"

echo
echo "[3/5] 启动唯一 daemon"

# 再次确认，防止 service.sh 在此期间启动
if pgrep -x pluskeyd >/dev/null 2>&1; then
    echo "[ERROR] 检测到其他 pluskeyd 正在运行"
    pgrep -a -x pluskeyd
    exit 1
fi

"$DAEMON" >> "$LOG" 2>&1 &

PID=$!

echo "[OK] 启动 PID=$PID"

sleep 1

echo
echo "[4/5] 检查 daemon"

COUNT=$(pgrep -x pluskeyd | wc -l)

echo "pluskeyd 数量: $COUNT"

if [ "$COUNT" -eq 1 ]; then
    echo "[OK] 当前只有一个 pluskeyd"
    pgrep -a -x pluskeyd
elif [ "$COUNT" -eq 0 ]; then
    echo "[ERROR] pluskeyd 没有成功运行"
    echo
    tail -50 "$LOG" 2>/dev/null
    exit 1
else
    echo "[ERROR] 检测到多个 pluskeyd："
    pgrep -a -x pluskeyd
    echo
    echo "请检查 KernelSU service.sh 是否同时启动了 daemon"
    exit 1
fi

echo
echo "[5/5] 最近日志"
echo "----------------------------------------------"

tail -40 "$LOG" 2>/dev/null || true

echo "----------------------------------------------"

echo
echo "=============================================="
echo "          RESTART CHECK COMPLETE"
echo "=============================================="