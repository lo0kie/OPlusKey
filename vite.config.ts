import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { ViteMinifyPlugin } from 'vite-plugin-minify';

// KernelSU WebUI 以 file:// 加载 webroot/index.html，
// ES module 跨文件加载会被 CORS 拦截，因此用 singlefile 内联全部 JS/CSS。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist/webroot',
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    reportCompressedSize: false,
    // 单文件产物：把字体等资源内联为 data URI
    assetsInlineLimit: 1024 * 1024,
  },
  plugins: [viteSingleFile(), ViteMinifyPlugin()],
});
