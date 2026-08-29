# OPlusKey

一加侧键（Plus Key）重映射模块，同时支持电源键与音量键，Magisk / KernelSU 都能刷。

每个键可以单独配置单击、双击、长按的动作，长按判定时长和持续触发也能分开调。实现方式是独占输入设备自行判定，再用 uinput 转发不需要拦截的事件，不改动系统分区。

## 功能

- 四个键独立配置：侧键、电源键、音量+、音量-
- 单击 / 双击 / 长按三种动作，长按阈值 100–10000ms 可调
- 长按可以持续触发，按固定间隔重复执行动作
- 保留原始行为（`native`）：只配单击时整键透传，不独占设备，原生连发和手势都不受影响
- 延迟转发（`passthrough`）：等判定结束后再转发一次按键
- 真实长按注入（`longpress:键码`）：带重复事件序列，能唤出 ColorOS 的电源菜单
- 动作可以是按键、shell 命令、intent 或指定 Activity
- 配置文件改完自动热重载，不用重启
- 模块页面内嵌 WebUI，可视化编辑全部配置

## 安装

1. 到 Releases 下载 `OPlusKey-<version>.zip`
2. 在 KernelSU / Magisk 管理器里刷入
3. 重启

刷完默认四个键都是关闭的，行为和原生一致，不占用任何输入设备。在模块页面的 WebUI 里打开某个键的开关，这个键才交给模块接管。

## 配置

配置文件是 `/data/adb/OPlusKey/config.conf`。

放在模块目录之外是有原因的：Magisk /
KernelSU 更新模块时会重建整个模块目录，配置留在里面的话，每次刷入都会被包里的默认值盖掉。放在 `/data/adb/`
下更新时没人动它（更新不执行 `uninstall.sh`），所以升级不会丢配置。

卸载模块时 `uninstall.sh` 会把整个 `/data/adb/OPlusKey` 删掉，不留残留。确实想留着
配置（比如卸载后马上重装），卸载前执行 `su -c 'touch /data/adb/OPlusKey/.keep'`，
有这个标记时只删调试日志。想恢复默认配置，删掉 `config.conf` 再重启，daemon 会重新生成一份。

从 v1.0.2-beta 及更早的版本升上来时，daemon 第一次启动会把模块目录里的旧配置搬过来，
旧文件保留不动（方便回滚），但不再读取，会随下一次模块更新或卸载一起清掉。

WebUI 保存后 daemon 会自动重新加载（靠 mtime + 文件大小判断）。

全局项：

| 键                        | 默认 | 说明                                   |
| ------------------------- | ---- | -------------------------------------- |
| `double_click_ms`         | 300  | 双击判定窗口，100–2000                 |
| `long_repeat_interval_ms` | 300  | 长按持续触发的间隔，50–5000            |
| `longpress_hold_ms`       | 3000 | `longpress:` 注入时按住多久，500–10000 |
| `vibrate`                 | 0    | 执行动作时振动反馈                     |

每个键一组，前缀是 `plus_` / `power_` / `vol_up_` / `vol_down_`（侧键可以省略前缀）：

| 键                    | 默认   | 说明             |
| --------------------- | ------ | ---------------- |
| `<key>_enabled`       | 0      | 是否接管这个键   |
| `<key>_single`        | native | 单击动作         |
| `<key>_double`        | none   | 双击动作         |
| `<key>_long`          | none   | 长按动作         |
| `<key>_long_press_ms` | 500    | 长按判定时长     |
| `<key>_long_repeat`   | 0      | 长按是否持续触发 |

### 动作写法

| 写法                             | 作用                                         |
| -------------------------------- | -------------------------------------------- |
| `none`                           | 拦截按键，什么都不做                         |
| `native`                         | 完全不碰这个键，保留原生行为                 |
| `passthrough`                    | 判定结束后转发一次按键                       |
| `keyevent:KEYCODE_HOME`          | 注入按键事件                                 |
| `shell:命令`                     | 执行 shell 命令                              |
| `intent:android.intent.action.X` | 发送 intent                                  |
| `app:包名/Activity`              | 启动指定组件                                 |
| `longpress:26`                   | uinput 注入真实长按，参数是键码（26 = 电源） |
| 其他任意字符串                   | 当成 shell 命令执行                          |

几个容易踩的点：

- `native` 只对单击有意义，双击或长按写成 `native` 会被当成 `none`
- 单击是 `native` 但又配了双击或长按时没法实时透传，会自动降级成 `passthrough`
- 电源键配了长按连发，系统自带的电源菜单就出不来了
- 音量键要保持 `native` 才能长按连续调节音量

例子，侧键单击开手电筒、双击截图：

```
plus_enabled=1
single=shell:echo 200 > /sys/class/leds/white:flash-1/brightness
double=service call color_screenshot 1
long=none
long_press_ms=500
```

手电筒的完整开关脚本（带状态判断）可以直接在 WebUI 的预设里选。

## 构建

需要 pnpm，编译 daemon 还需要 Android NDK。

```sh
pnpm install
pnpm build:daemon   # 交叉编译，输出 module/bin/pluskeyd
pnpm build          # WebUI，输出 dist/webroot
pnpm pack:module    # 打包成 dist/OPlusKey-<version>.zip
```

没有 NDK 时，把 `module/` 推到设备上，在 Termux 里跑 `module/build.sh`。

## 自动更新

`module.prop` 里的 `updateJson` 指向 Releases 的 `update.json`，管理器定期检查，发现更高的 `versionCode`
就提示更新，zip 取的是固定名的 `OPlusKey-latest.zip`。

发版只需要打 tag，版本号由 CI 写入：

```sh
git tag v1.0.3-beta && git push origin v1.0.3-beta
```

CI 会把 tag 版本写进 `module.prop`（`versionCode` = 主 _ 10000 + 次 _ 100 + 修订），构建模块，然后发 Release，附件带
`OPlusKey-<version>.zip`、`OPlusKey-latest.zip`、 `update.json` 和更新日志。

仓库里的 `module.prop` 和 `update.json` 是占位值，不用手动维护版本号。

注意：v1.0.1-beta 及更早的包里 `updateJson`
指向的还不是 Releases 地址（有的版本甚至没写这一行），这些版本收不到更新提示，手动刷一次最新版就好。

## 调试

见 [docs/DEBUG.md](docs/DEBUG.md)。

## 协议

[MIT](LICENSE)
