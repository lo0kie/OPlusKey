#!/system/bin/sh
# 安装/更新后修正权限。
# 注意：部分管理器（如当前使用的 KernelSU 版本）不提供 Magisk 的 set_perm
# 系列辅助函数，因此统一用 chmod（本脚本以 root 执行，必然生效）。

chmod 0755 "$MODDIR" "$MODDIR/bin" "$MODDIR/config" "$MODDIR/webroot" 2>/dev/null
chmod 0755 "$MODDIR/bin/pluskeyd" "$MODDIR/service.sh" "$MODDIR/restart.sh" "$MODDIR/uninstall.sh" 2>/dev/null
chmod 0644 "$MODDIR/module.prop" "$MODDIR/config/config.conf" "$MODDIR/skip_mount" 2>/dev/null
chmod 0644 "$MODDIR/webroot/icon.svg" "$MODDIR/webroot/index.html" 2>/dev/null
