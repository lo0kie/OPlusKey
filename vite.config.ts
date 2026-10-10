import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { ViteMinifyPlugin } from 'vite-plugin-minify';

// KernelSU WebUI 以 file:// 加载 webroot/index.html，
// ES module 跨文件加载会被 CORS 拦截，因此用 singlefile 内联全部 JS/CSS。
//
// 构建分两级：
//   release（默认，MODE=production）：不含调试面板与调试逻辑
//   debug（MODE=debug）             ：保留调试面板与诊断工具
// 由 scripts/pack.mjs 通过 --debug 传入 mode 触发。
export default defineConfig(({ mode }) => {
  const debug = mode === 'debug';
  return {
    base: './',
    define: {
      __DEBUG_BUILD__: JSON.stringify(debug),
    },
    build: {
      // debug 产物单独放，避免与 release 互相覆盖（打包脚本按变体取各自目录）
      outDir: debug ? 'dist/webroot-debug' : 'dist/webroot',
      emptyOutDir: true,
      target: 'es2020',
      cssCodeSplit: false,
      reportCompressedSize: false,
      // 单文件产物：把字体等资源内联为 data URI
      assetsInlineLimit: 1024 * 1024,
    },
    plugins: [
      // release 版把调试面板整块 HTML 从产物里删掉，而不是运行时隐藏，
      // 避免调试标记（按钮/日志容器）随包分发
      {
        name: 'strip-debug-html',
        transformIndexHtml(html) {
          if (debug) return html;
          return html.replace(/<!--\s*DEBUG_START\s*-->[\s\S]*?<!--\s*DEBUG_END\s*-->/g, '');
        },
      },
      viteSingleFile(),
      ViteMinifyPlugin(),
    ],
  };
});
