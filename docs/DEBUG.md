# 调试

模块目录是 `/data/adb/modules/OPlusKey`，配置文件不在这里，在 `/data/adb/OPlusKey/config.conf`（更新模块不会动它）。

## 日志

- `/data/adb/modules/OPlusKey/pluskey.log` —— daemon 的运行日志，超过 2MB 自动清空重写
- `/data/adb/OPlusKey/webui-debug.log` —— WebUI 每次读配置、保存配置、收集诊断时写入

daemon 日志里几个有用的标记：

- `CONFIG <键名>` —— 这个键实际生效的动作、长按阈值、是否走了 native
- `scan:` —— 启动时扫到的输入设备，哪些被选中、哪些被跳过
- `grab:` —— 被独占的设备
- `CONFIG FILE CHANGED` —— 检测到配置文件变化，开始热重载
- `LONGPRESS inject` —— 长按注入子进程的 pid

触摸设备即使声明了 `KEY_POWER` 也会被跳过（日志里会写明原因），否则独占它会丢掉 EV_ABS 数据，屏幕就触摸失灵了。

## 常用命令

daemon 是否在跑：

```sh
ps -A -o pid,args | grep pluskeyd
```

看日志：

```sh
tail -100 /data/adb/modules/OPlusKey/pluskey.log
```

看当前生效的配置：

```sh
cat /data/adb/OPlusKey/config.conf
```

## 进程模型

`service.sh`
是前台常驻的，启动 daemon 后进入看护循环，每 5 秒检查一次，daemon 崩了或者被杀就重新拉起。`run/supervisor.pid`
记录看护进程的 pid，管理器重复调用 `service.sh` 不会起第二个看护。

daemon 自己还有一层保护：`run/pluskeyd.lock` 上的 flock，重复启动会直接退出，所以看护循环不会导致多实例。

卸载时 `uninstall.sh` 先写 `run/stop`，看护循环看到这个文件就退出，避免刚 pkill 完
又被拉起来；然后删掉 `/data/adb/OPlusKey`（配置 + WebUI 调试日志），
除非里面有 `.keep`。更新模块不执行 `uninstall.sh`，所以升级时配置不动。

`restart.sh` 是给手动调试用的：pkill 之后等看护重新拉起；如果看护没在跑，就自己启动 daemon。

## WebUI 诊断

模块页面底部的调试模式开关打开后，会多出两个按钮：

- `重新读取` —— 重新拉一次配置，把原文、解析结果、最终状态都写进调试日志
- `收集诊断` —— 环境信息、daemon 进程、配置原文、模块文件列表、daemon 日志末尾 40 行

WebUI 的多行 shell 输出统一走 base64 单行传输，绕开 KSU WebUI 吞掉多行输出的问题。

状态栏停在「页面脚本尚未启动」说明 JS 根本没执行；推进到「正在读取配置…」之后才失败，就要查 KernelSU 的 exec API 和
`config/config.conf` 的权限了。
