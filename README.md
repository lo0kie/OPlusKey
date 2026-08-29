# OPlusKey

一加侧键（Plus Key）重映射模块，同时支持电源键与音量键，Magisk / KernelSU 均可刷入。

每个键可单独配置单击、双击、长按动作。实现方式是独占输入设备自行判定，再用 uinput 转发不拦截的事件，不修改系统分区。

## 使用

1. 到 Releases 下载 zip，在管理器里刷入，重启
2. 打开模块页面的 WebUI，开启需要的按键并配置动作

默认四个键全部关闭，行为与原生一致。

配置文件在 `/data/adb/OPlusKey/config.conf`（模块目录之外，更新不会丢）；卸载会一并删除，想保留先执行
`su -c 'touch /data/adb/OPlusKey/.keep'`。

每个键一组配置，前缀为 `plus_` / `power_` / `vol_up_` / `vol_down_` （旧版无前缀的侧键键名仍能识别）：

| 键                    | 默认   | 说明             |
| --------------------- | ------ | ---------------- |
| `<key>_enabled`       | 0      | 是否接管这个键   |
| `<key>_single`        | native | 单击动作         |
| `<key>_double`        | none   | 双击动作         |
| `<key>_long`          | none   | 长按动作         |
| `<key>_long_press_ms` | 500    | 长按判定时长     |
| `<key>_long_repeat`   | 0      | 长按是否持续触发 |

动作写法：

| 写法                                                 | 作用                               |
| ---------------------------------------------------- | ---------------------------------- |
| `none`                                               | 拦截按键，什么都不做               |
| `native`                                             | 完全不碰这个键，保留原生行为       |
| `passthrough`                                        | 判定结束后转发一次按键             |
| `keyevent:KEYCODE_HOME`                              | 注入按键事件                       |
| `shell:命令` / `intent:ACTION` / `app:包名/Activity` | 执行命令 / 拉起界面                |
| `longpress:26`                                       | uinput 注入真实长按（26 = 电源键） |
| 其他任意字符串                                       | 当作 shell 命令执行                |

几个坑：

- `native` 只对单击有意义，双击或长按写成 `native` 会被当成 `none`
- 单击 `native` 但又配了双击或长按，自动降级为 `passthrough`
- 电源键配长按连发会屏蔽系统电源菜单；音量键保持 `native` 才能长按连续调节音量

## 构建

需要 pnpm，编译 daemon 还需要 Android NDK。

```sh
pnpm install
pnpm build:daemon   # 输出 module/bin/pluskeyd
pnpm build          # WebUI
pnpm pack:module    # dist/OPlusKey-<version>.zip
```

没有 NDK 时，把 `module/` 推到设备，在 Termux 里跑 `module/build.sh`。

## 发版

打 tag 即可，版本号由 CI 写入（`versionCode` = 主×10000 + 次×100 + 修订）：

```sh
git tag v1.0.4-beta && git push origin v1.0.4-beta
```

CI 构建并发布 Release，管理器靠 `updateJson` 检查更新。仓库里的 `module.prop` / `update.json` 是占位值，不用手动改。

## 调试

见 [docs/DEBUG.md](docs/DEBUG.md)。

## 协议

[MIT](LICENSE)
