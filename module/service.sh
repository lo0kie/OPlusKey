#!/system/bin/sh
# Magisk/KernelSU 以完整模块路径调用本脚本，直接从 $0 取模块目录
MODDIR=${0%/*}
DAEMON="$MODDIR/bin/pluskeyd"
PIDDIR="$MODDIR/run"
PIDFILE="$PIDDIR/pluskeyd.pid"
LOGFILE="$MODDIR/pluskey.log"
CONFIG="$MODDIR/config/config.conf"

mkdir -p "$PIDDIR"
mkdir -p "$MODDIR/config"

# 部分管理器解压不保留权限位，每次启动前自修（以 root 运行，必然生效）
chmod 755 "$DAEMON" "$MODDIR/restart.sh" "$MODDIR/uninstall.sh" 2>/dev/null
chmod 644 "$MODDIR/module.prop" "$CONFIG" 2>/dev/null

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOGFILE"
}

log "=============================================="
log "pluskeyd service start"
log "=============================================="
log "MODDIR=$MODDIR"
log "DAEMON=$DAEMON"
log "PIDFILE=$PIDFILE"

if [ "$(id -u)" != "0" ]; then
    log "ERROR: service is not running as root"
    exit 1
fi

if [ ! -x "$DAEMON" ]; then
    log "ERROR: daemon not executable: $DAEMON"
    exit 1
fi

if [ ! -f "$CONFIG" ]; then
    log "config does not exist, creating default config"
    cat > "$CONFIG" <<'EOF'
# OPlusKey Remapper
# 动作格式: none=屏蔽 | native=保留原始按键 | passthrough=判定后转发一次按键
#          keyevent:KEYCODE | shell:命令 | intent:ACTION | app:包名/Activity | 其他任意 shell 命令

double_click_ms=300
long_repeat_interval_ms=300
longpress_hold_ms=3000
vibrate=0

# 侧键 (Plus Key)
long_press_ms=600
single=none
double=none
long=none
long_repeat=0

# 电源键
power_long_press_ms=800
power_single=native
power_double=none
power_long=none
power_long_repeat=0

# 音量+
vol_up_long_press_ms=600
vol_up_single=native
vol_up_double=none
vol_up_long=none
vol_up_long_repeat=0

# 音量-
vol_down_long_press_ms=600
vol_down_single=native
vol_down_double=none
vol_down_long=none
vol_down_long_repeat=0
EOF
    chmod 600 "$CONFIG"
    log "default config created"
else
    log "config already exists, keeping current config"
fi

log "current config:"
cat "$CONFIG" >> "$LOGFILE"

is_our_daemon() {
    PID="$1"
    [ -n "$PID" ] || return 1
    [ -d "/proc/$PID" ] || return 1
    CMDLINE="$(cat "/proc/$PID/cmdline" 2>/dev/null | tr '\000' ' ')"
    case "$CMDLINE" in
        "$DAEMON"*) return 0 ;;
        *) return 1 ;;
    esac
}

find_daemon_pid() {
    if [ -f "$PIDFILE" ]; then
        PID="$(cat "$PIDFILE" 2>/dev/null)"
        if is_our_daemon "$PID"; then
            echo "$PID"
            return 0
        fi
    fi
    for PID in $(pidof pluskeyd 2>/dev/null); do
        if is_our_daemon "$PID"; then
            echo "$PID"
            return 0
        fi
    done
    return 1
}

EXISTING_PID="$(find_daemon_pid)"

if [ -n "$EXISTING_PID" ]; then
    log "pluskeyd already running pid=$EXISTING_PID"
    echo "$EXISTING_PID" > "$PIDFILE"
    chmod 600 "$PIDFILE"
    log "service start finished: existing daemon reused"
    exit 0
fi

rm -f "$PIDFILE"

log "starting daemon"
"$DAEMON" >> "$LOGFILE" 2>&1 &
DAEMON_PID=$!

log "daemon forked pid=$DAEMON_PID"
echo "$DAEMON_PID" > "$PIDFILE"
chmod 600 "$PIDFILE"

START_OK=0
for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
        START_OK=1
        break
    fi
    log "daemon exited during startup, attempt check=$i"
done

if [ "$START_OK" != "1" ]; then
    log "ERROR: daemon failed to start"
    rm -f "$PIDFILE"
    exit 1
fi

if ! is_our_daemon "$DAEMON_PID"; then
    log "ERROR: started PID is not our daemon"
    kill "$DAEMON_PID" 2>/dev/null
    rm -f "$PIDFILE"
    exit 1
fi

log "pluskeyd started successfully"
log "pid=$DAEMON_PID"
exit 0
