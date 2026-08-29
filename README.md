# OPlusKey

一加侧键（Plus Key）重映射 Magisk / KernelSU 模块，同时支持电源键与音量键。

每个键独立配置单击 / 双击 / 长按动作与长按判定时长，支持长按持续触发。

## 动作类型

| 动作                                        | 说明                                                            |
| ------------------------------------------- | --------------------------------------------------------------- |
| `none`                                      | 拦截按键，不执行任何动作                                        |
| `native`                                    | 完全不接触该键，保留原生行为                                    |
| `passthrough`                               | 判定完成后转发一次按键                                          |
| `keyevent:KEYCODE_X`                        | 注入按键事件                                                    |
| `shell:命令` / `intent:ACTION` / `app:组件` | 执行命令 / 拉起 Activity                                        |
| `longpress:键码`                            | 通过 uinput 注入带重复事件的真实长按（可触发 ColorOS 电源菜单） |

## 构建

```sh
pnpm install
pnpm build:daemon   # 需要 Android NDK，输出 module/bin/pluskeyd
pnpm build          # WebUI（TypeScript + Vite，MD3E 风格）
pnpm pack:module    # 打包为 dist/OPlusKey-<version>.zip（不含源码）
```

没有 NDK 时，可把 `module/` 推到设备后在 Termux 里执行 `module/build.sh` 编译。

## 安装

KernelSU / Magisk 管理器刷入 zip。配置文件位于
`/data/adb/modules/OPlusKey/config/config.conf`，改动后自动热重载；WebUI（管理器模块页面）可视化编辑全部配置。

## 发版与自动更新

1. 改 `module/module.prop` 的 `version` / `versionCode`
2. 同步更新根目录 `update.json` 的 `version` / `versionCode` / `changelog`
3. 提交后打 `v` 标签推送，Actions 自动构建并在 Release 附件带上
   `OPlusKey-<version>.zip` 和固定名的 `OPlusKey-latest.zip`

管理器通过 `module.prop` 里的 `updateJson` 定期检查 `update.json`，
发现更高的 `versionCode` 即提示更新（zip 指向 latest Release 附件）。

## 目录

```
src/               pluskeyd.c（daemon）+ WebUI 源码（TS）
module/            模块内容（脚本、默认配置、META-INF、bin/ 构建产物）
scripts/           交叉编译与打包脚本
docs/              调试记录
```

## 协议

[MIT](LICENSE)
