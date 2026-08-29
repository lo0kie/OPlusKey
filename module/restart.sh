#!/data/data/com.termux/files/usr/bin/bash

MODDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DAEMON="$MODDIR/bin/pluskeyd"
LOG="$MODDIR/pluskey.log"
PIDFILE="$MODDIR/run/pluskeyd.pid"
SUPERVISOR_PIDFILE="$MODDIR/run/supervisor.pid"

# 权限自修（部分管理器解压不保留权限位）
chmod 755 "$DAEMON" 2>/dev/null

echo "=============================================="
echo "       OnePlus 15 Plus Key 重启服务"
echo "=============================================="

if [ "$(id -u)" != "0" ]; then
    echo "[ERROR] 必须 root"
    exit 1
fi

# 看护进程是否存活（service.sh 自身，前台阻塞在看护循环里）
is_supervisor() {
    PID="$1"
    [ -n "$PID" ] || return 1
    [ -d "/proc/$PID" ] || return 1
    case "$(cat "/proc/$PID/cmdline" 2>/dev/null | tr '\000' ' ')" in
        *"$MODDIR/service.sh"*) return 0 ;;
        *) return 1 ;;
    esac
}

SUPERVISOR_PID=""
if [ -f "$SUPERVISOR_PIDFILE" ]; then
    CANDIDATE="$(cat "$SUPERVISOR_PIDFILE" 2>/dev/null)"
    if is_supervisor "$CANDIDATE"; then
        SUPERVISOR_PID="$CANDIDATE"
    fi
fi

echo "[1/5] 停止当前 daemon"

pkill -9 -x pluskeyd 2>/dev/null || true

sleep 1

if pgrep -x pluskeyd >/dev/null 2>&1; then
    # 看护进程可能已经抢先重启了 daemon，这不算失败
    if [ -z "$SUPERVISOR_PID" ]; then
        echo "[ERROR] 无法停止旧 pluskeyd"
        pgrep -a -x pluskeyd
        exit 1
    fi
    echo "[INFO] 看护进程已立即拉起新 daemon"
else
    echo "[OK] 旧进程已停止"
fi

echo
echo "[2/5] 检查 daemon"

if [ ! -x "$DAEMON" ]; then
    echo "[ERROR] daemon 不存在或不可执行："
    echo "$DAEMON"
    exit 1
fi

ls -lh "$DAEMON"

echo
echo "[3/5] 重新拉起 daemon"

if [ -n "$SUPERVISOR_PID" ]; then
    echo "[INFO] 看护进程 pid=$SUPERVISOR_PID 在运行，等待其自动重启（最多 30s）"
    NEW_PID=""
    i=0
    while [ "$i" -lt 30 ]; do
        sleep 1
        i=$((i + 1))
        NEW_PID="$(pgrep -x pluskeyd | head -n 1)"
        [ -n "$NEW_PID" ] && break
    done
    if [ -z "$NEW_PID" ]; then
        echo "[ERROR] 看护进程未能在 30s 内拉起 daemon"
        tail -50 "$LOG" 2>/dev/null
        exit 1
    fi
    echo "[OK] 看护已重启 daemon pid=$NEW_PID"
else
    # 没有看护进程（例如 service.sh 未启动），手动启动
    rm -f "$PIDFILE"
    "$DAEMON" >> "$LOG" 2>&1 &
    NEW_PID=$!
    echo "[OK] 手动启动 PID=$NEW_PID"
    sleep 1
    if ! kill -0 "$NEW_PID" 2>/dev/null; then
        echo "[ERROR] daemon 启动后立即退出"
        tail -50 "$LOG" 2>/dev/null
        exit 1
    fi
    echo "$NEW_PID" > "$PIDFILE" 2>/dev/null
    chmod 600 "$PIDFILE" 2>/dev/null
fi

echo
echo "[4/5] 检查 daemon 数量"

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
