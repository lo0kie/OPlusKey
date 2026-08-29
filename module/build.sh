#!/data/data/com.termux/files/usr/bin/bash

set -u

MODDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SRC="$MODDIR/src/pluskeyd.c"
OUT="$MODDIR/bin/pluskeyd"
# 配置在模块目录之外，更新模块不会丢
CONFIG="/data/adb/OPlusKey/config.conf"

# MT Terminal / Termux clang
CLANG="/data/data/com.termux/files/usr/bin/clang"

echo
echo "=============================================="
echo "        OnePlus 15 Plus Key 一键编译器"
echo "=============================================="
echo

# ============================================================
# 1. Root
# ============================================================

if [ "$(id -u)" != "0" ]; then
    echo "[ERROR] 当前不是 root"
    echo
    echo "请执行："
    echo
    echo "su"
    echo
    echo "然后重新执行："
    echo
    echo "bash $MODDIR/build.sh"
    exit 1
fi

echo "[OK] root"

# ============================================================
# 2. 检查 clang
# ============================================================

echo
echo "[1/8] 检查 clang"

if [ ! -x "$CLANG" ]; then
    echo "[ERROR] 找不到 Termux clang："
    echo "$CLANG"
    echo
    echo "请确认 Termux 已安装 clang："
    echo "pkg install clang"
    exit 1
fi

echo "[OK] clang:"
"$CLANG" --version | head -n 1

# ============================================================
# 3. 检查源码
# ============================================================

echo
echo "[2/8] 检查源码"

if [ ! -f "$SRC" ]; then
    echo "[ERROR] 找不到源码："
    echo "$SRC"
    echo
    echo "实际搜索结果："

    find "$MODDIR" -name "pluskeyd.c" -type f -print 2>/dev/null

    exit 1
fi

echo "[OK] source:"
ls -lh "$SRC"

# ============================================================
# 4. 创建目录
# ============================================================

echo
echo "[3/8] 创建输出目录"

mkdir -p "$MODDIR/bin"
mkdir -p "$(dirname "$CONFIG")"

echo "[OK] $MODDIR/bin"
echo "[OK] $(dirname "$CONFIG")"

# ============================================================
# 5. 配置文件
# ============================================================

echo
echo "[4/8] 检查配置文件"

if [ ! -f "$CONFIG" ]; then

    echo "[INFO] 配置文件不存在，创建默认配置"

    cat > "$CONFIG" <<'CONFIG_EOF'
# OPlusKey Remapper
# 动作格式: none=屏蔽 | native=保留原始按键 | passthrough=判定后转发一次按键
#          keyevent:KEYCODE | shell:命令 | intent:ACTION | app:包名/Activity | 其他任意 shell 命令

double_click_ms=300
long_repeat_interval_ms=300
longpress_hold_ms=3000
vibrate=0

# 侧键 (Plus Key)
plus_enabled=0
long_press_ms=500
single=native
double=none
long=none
long_repeat=0

# 电源键
power_enabled=0
power_long_press_ms=500
power_single=native
power_double=none
power_long=none
power_long_repeat=0

# 音量+
vol_up_enabled=0
vol_up_long_press_ms=500
vol_up_single=native
vol_up_double=none
vol_up_long=none
vol_up_long_repeat=0

# 音量-
vol_down_enabled=0
vol_down_long_press_ms=500
vol_down_single=native
vol_down_double=none
vol_down_long=none
vol_down_long_repeat=0
CONFIG_EOF

    chmod 600 "$CONFIG"

    echo "[OK] 已创建："
    cat "$CONFIG"

else

    echo "[OK] 配置文件已存在，不覆盖"

    echo
    echo "当前配置："
    cat "$CONFIG"
fi

# ============================================================
# 6. 编译
# ============================================================

echo
echo "=============================================="
echo "[5/8] 开始编译"
echo "=============================================="
echo

TMP="$OUT.new"

rm -f "$TMP"

echo "[INFO] source:"
echo "$SRC"

echo
echo "[INFO] output:"
echo "$TMP"

echo
echo "[INFO] compiler:"
echo "$CLANG"

echo
echo "[INFO] flags:"
echo "--target=aarch64-linux-android35"
echo "-O2"
echo "-Wall"
echo "-Wextra"
echo "-fno-stack-protector"

echo
echo "[BUILD]"

"$CLANG" \
    --target=aarch64-linux-android35 \
    -O2 \
    -Wall \
    -Wextra \
    -fno-stack-protector \
    "$SRC" \
    -o "$TMP"

RET=$?

if [ "$RET" != "0" ]; then
    echo
    echo "=============================================="
    echo "[ERROR] 编译失败"
    echo "=============================================="
    echo
    echo "clang exit code: $RET"
    echo
    echo "注意：本脚本没有使用："
    echo "  -nostdlib"
    echo "  -static"
    echo "  -no-pie"
    echo
    echo "Android libc 会正常参与链接。"
    echo
    rm -f "$TMP"
    exit "$RET"
fi

echo
echo "[OK] 编译完成"

# ============================================================
# 7. ELF 检查
# ============================================================

echo
echo "[6/8] ELF 检查"

if command -v file >/dev/null 2>&1; then
    file "$TMP"
else
    echo "[WARN] file 命令不可用，跳过"
fi

chmod 755 "$TMP"

echo
echo "[INFO] 新文件："
ls -lh "$TMP"

# ============================================================
# 8. 安装
# ============================================================

echo
echo "=============================================="
echo "[7/8] 安装 daemon"
echo "=============================================="
echo

if [ -f "$OUT" ]; then

    echo "[INFO] 发现旧版本："

    ls -lh "$OUT"

    BACKUP="$OUT.backup"

    rm -f "$BACKUP"

    cp "$OUT" "$BACKUP"

    echo "[OK] 旧版本备份："
    echo "$BACKUP"

fi

mv -f "$TMP" "$OUT"

chmod 755 "$OUT"

chown root:root "$OUT" 2>/dev/null || true

echo
echo "[OK] 安装完成："
ls -lh "$OUT"

# ============================================================
# 最终检查
# ============================================================

echo
echo "=============================================="
echo "[8/8] 最终检查"
echo "=============================================="
echo

echo "[Binary]"
ls -lh "$OUT"

echo
echo "[Config]"
ls -lh "$CONFIG"

echo
echo "[Config content]"
cat "$CONFIG"

echo
echo "[Binary strings]"

if command -v strings >/dev/null 2>&1; then
    strings "$OUT" 2>/dev/null | \
        grep -E \
        'pluskeyd|EVIOCGRAB|UINPUT|LONG_PRESS|SHORT_PRESS|DOUBLE|config|diagnostic|GRAB' \
        | head -50 \
        || true
else
    echo "[WARN] strings 不可用"
fi

echo
echo "=============================================="
echo "           BUILD SUCCESS"
echo "=============================================="
echo
echo "源码："
echo "$SRC"
echo
echo "输出："
echo "$OUT"
echo
echo "配置："
echo "$CONFIG"
echo
echo "下一步："
echo "  重启模块 / 重启手机后测试"
echo
echo "测试 daemon："
echo "  su -c 'ps -A | grep pluskeyd'"
echo
echo "查看日志："
echo "  su -c 'cat $MODDIR/pluskey.log'"
echo
echo "=============================================="
