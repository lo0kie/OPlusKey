#!/system/bin/sh
# Magisk/KernelSU 以完整模块路径调用本脚本，直接从 $0 取模块目录
MODDIR=${0%/*}
DAEMON="$MODDIR/bin/pluskeyd"
PIDDIR="$MODDIR/run"
PIDFILE="$PIDDIR/pluskeyd.pid"
SUPERVISOR_PIDFILE="$PIDDIR/supervisor.pid"
STOPFILE="$PIDDIR/stop"
LOGFILE="$MODDIR/pluskey.log"
# 配置在模块目录之外，更新模块不会丢；默认配置由 daemon 首次启动时创建
PERSIST_DIR="/data/adb/OPlusKey"
CONFIG="$PERSIST_DIR/config.conf"

mkdir -p "$PIDDIR"
mkdir -p "$PERSIST_DIR"

# 部分管理器解压不保留权限位，每次启动前自修（以 root 运行，必然生效）
chmod 755 "$DAEMON" "$MODDIR/restart.sh" "$MODDIR/uninstall.sh" 2>/dev/null
chmod 644 "$MODDIR/module.prop" 2>/dev/null
chmod 600 "$CONFIG" 2>/dev/null

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

log "CONFIG=$CONFIG"

if [ -f "$CONFIG" ]; then
    log "config found, keeping it"
    log "current config:"
    cat "$CONFIG" >> "$LOGFILE"
else
    # 旧版本（v1.0.2-beta 及更早）的配置在模块目录里，daemon 启动时会自动迁移过来
    if [ -f "$MODDIR/config/config.conf" ]; then
        log "legacy config found at $MODDIR/config/config.conf, daemon will migrate it"
    else
        log "no config yet, daemon will create the default one"
    fi
fi

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

# 判断某个 PID 是否是本模块的看护进程（本脚本自身）
is_supervisor() {
    PID="$1"
    [ -n "$PID" ] || return 1
    [ -d "/proc/$PID" ] || return 1
    CMDLINE="$(cat "/proc/$PID/cmdline" 2>/dev/null | tr '\000' ' ')"
    case "$CMDLINE" in
        *"$MODDIR/service.sh"*) return 0 ;;
        *) return 1 ;;
    esac
}

# 启动 daemon，成功返回 0
start_daemon() {
    rm -f "$PIDFILE"

    log "starting daemon"
    "$DAEMON" >> "$LOGFILE" 2>&1 &
    DAEMON_PID=$!

    log "daemon forked pid=$DAEMON_PID"

    i=1
    while [ "$i" -le 10 ]; do
        sleep 1
        if kill -0 "$DAEMON_PID" 2>/dev/null; then
            if is_our_daemon "$DAEMON_PID"; then
                echo "$DAEMON_PID" > "$PIDFILE"
                chmod 600 "$PIDFILE"
                log "pluskeyd started successfully pid=$DAEMON_PID"
                return 0
            fi
            log "ERROR: started PID is not our daemon"
            kill "$DAEMON_PID" 2>/dev/null
            rm -f "$PIDFILE"
            return 1
        fi
        log "daemon exited during startup, attempt check=$i"
        i=$((i + 1))
    done

    log "ERROR: daemon failed to start"
    rm -f "$PIDFILE"
    return 1
}

# 已有看护进程在运行就不重复看护（管理器可能多次调用 service.sh）
if [ -f "$SUPERVISOR_PIDFILE" ]; then
    SUPERVISOR_PID="$(cat "$SUPERVISOR_PIDFILE" 2>/dev/null)"
    if is_supervisor "$SUPERVISOR_PID"; then
        log "supervisor already running pid=$SUPERVISOR_PID, exit"
        exit 0
    fi
fi

echo "$$" > "$SUPERVISOR_PIDFILE"
chmod 600 "$SUPERVISOR_PIDFILE"
rm -f "$STOPFILE"

EXISTING_PID="$(find_daemon_pid)"

if [ -n "$EXISTING_PID" ]; then
    log "pluskeyd already running pid=$EXISTING_PID"
    echo "$EXISTING_PID" > "$PIDFILE"
    chmod 600 "$PIDFILE"
else
    start_daemon
fi

# 看护循环：Magisk/KernelSU 的 service 脚本以前台方式运行，
# 阻塞在这里即可持续守护；daemon 崩溃/被杀后 5 秒内自动拉起。
# uninstall.sh 写入 $STOPFILE 通知本循环退出（卸载时不要把 daemon 拉回来）。
log "entering supervisor loop pid=$$"
while [ ! -f "$STOPFILE" ]; do
    if [ ! -x "$DAEMON" ]; then
        log "ERROR: daemon no longer executable, supervisor exiting"
        break
    fi
    CURRENT_PID="$(find_daemon_pid)"
    if [ -z "$CURRENT_PID" ]; then
        log "daemon is gone, restarting"
        start_daemon
    else
        echo "$CURRENT_PID" > "$PIDFILE"
    fi
    sleep 5
done

rm -f "$SUPERVISOR_PIDFILE"
log "supervisor exiting pid=$$"
exit 0
