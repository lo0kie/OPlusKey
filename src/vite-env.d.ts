/// <reference types="vite/client" />

/* 构建期注入：debug 构建为 true，release 构建为 false（见 vite.config.ts）。
 * release 版会连同调试面板 HTML 一起被 tree-shake 掉。 */
declare const __DEBUG_BUILD__: boolean;
