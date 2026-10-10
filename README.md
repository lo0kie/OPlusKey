# OPlusKey

Magisk / KernelSU 模块：为一加侧键（Plus Key）添加单击、双击、长按重映射。

## 下载

[Releases](https://github.com/lo0kie/OPlusKey/releases)

## 使用

刷入模块后重启。

配置文件在 `/data/adb/OPlusKey/config.conf`。

| 键                             | 默认   | 说明                   |
| ------------------------------ | ------ | ---------------------- |
| `plus_enabled`                 | 0      | 是否接管侧键           |
| `plus_single`                  | native | 单击动作               |
| `plus_double`                  | none   | 双击动作               |
| `plus_long`                    | none   | 长按动作               |
| `plus_long_press_ms`           | 500    | 长按判定时长           |
| `plus_long_repeat`             | 0      | 长按是否持续触发       |
| `plus_long_repeat_interval_ms` | 300    | 持续触发间隔，100–5000 |

动作写法：`none` 拦截、`native` 保留原生、`passthrough` 判定后转发、`keyevent:KEYCODE_HOME` 注入按键、
`flashlight:` 开关手电筒、`shell:命令` / `intent:ACTION` / `app:包名/Activity`、`longpress:26` 注入长按，
其他任意字符串按 shell 命令执行。

## 许可

[MIT](LICENSE)
