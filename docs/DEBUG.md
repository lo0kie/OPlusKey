# v2.2.1-debug

This build is for diagnosing the KernelSU WebUI initialization issue.

## WebUI debug log

`/data/adb/modules/oneplus15_pluskey/webui-debug.log`

## daemon log

`/data/adb/modules/oneplus15_pluskey/pluskey.log`

The WebUI now:

- renders before calling KernelSU exec
- dynamically imports `kernelsu` and logs success/failure
- logs every exec command and result
- catches JS errors and unhandled promise rejections
- has a `收集诊断` button
- writes a small WebUI debug file

If the page stays at `页面脚本尚未启动`, the JavaScript module itself is not executing. If it reaches
`界面已加载，正在连接 KernelSU…` but fails afterwards, the KernelSU JS API is the next suspect.
