// 模块打包脚本：产出可直接刷入的模块 zip（不含任何源码）
// 用法: pnpm pack:module             发布版（release，无日志，默认）
//       pnpm pack:module -- --debug  调试版（debug，含日志与 WebUI 调试面板）
//       pnpm pack:module -- --strict 缺 daemon / webroot 时直接失败（CI 用，可与 --debug 组合）
// 组装 module/ 下的模块内容:
//     module.prop / service.sh / restart.sh / uninstall.sh / skip_mount
//     META-INF/ + webroot/ + bin/pluskeyd
// debug 版从 module/bin-debug/ 取 daemon、从 dist/webroot-debug/ 取 WebUI，
// 产物名带 -debug 后缀，与 release 包区分。
// 注意：不打进 config/，配置文件在 /data/adb/OPlusKey 下，
//      包里带一份会在每次刷入时覆盖用户的配置
//   打包为 dist/<id>-<version>[-debug].zip

import { ZipArchive } from 'archiver';
import {
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const moduleDir = join(root, 'module');
const distDir = join(root, 'dist');
const STRICT = process.argv.includes('--strict');
const DEBUG = process.argv.includes('--debug');
const VARIANT = DEBUG ? 'debug' : 'release';
const staging = join(distDir, 'module' + (DEBUG ? '-debug' : ''));

/* 缺料在 CI 里必须失败：否则会静默发布一个装上就不可用的模块 */
function fatal(msg) {
  console.error('[ERROR] ' + msg);
  process.exit(1);
}

// ---------- 1. 组装暂存目录 ----------
console.log('[1/3] 组装模块文件...');
// 只清暂存目录，不动 dist/ 本身（避免 zip 被占用时清理失败，也保留历史包）
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(join(staging, 'META-INF', 'com', 'google', 'android'), { recursive: true });

// 模块根文件（来自 module/）
for (const f of ['module.prop', 'service.sh', 'restart.sh', 'uninstall.sh', 'skip_mount', 'customize.sh']) {
  copyFileSync(join(moduleDir, f), join(staging, f));
}
// 安装器
for (const f of ['update-binary', 'updater-script']) {
  copyFileSync(
    join(moduleDir, 'META-INF', 'com', 'google', 'android', f),
    join(staging, 'META-INF', 'com', 'google', 'android', f)
  );
}
// 不打配置：默认配置由 daemon 在 /data/adb/OPlusKey/config.conf 首次启动时生成
// WebUI 构建产物（vite 输出到 dist/webroot）——由 pnpm build 生成，本脚本只负责组装。
// debug 包必须由 pnpm build:web -- --mode debug 产出，两条构建线彼此独立。
const webrootSrc = join(root, 'dist', DEBUG ? 'webroot-debug' : 'webroot');
if (!existsSync(join(webrootSrc, 'index.html'))) {
  fatal(`${webrootSrc.slice(root.length + 1)}/index.html 不存在，请先执行 pnpm build${DEBUG ? ':debug' : ''}（或直接跑 pnpm pack:module${DEBUG ? ':debug' : ''}）`);
}
cpSync(webrootSrc, join(staging, 'webroot'), { recursive: true });

// launcher.png：管理器显示的模块图标，由 public/icon.svg 渲染到 zip 根目录
const launcherPng = await sharp(join(root, 'public', 'icon.svg'), { density: 341 })
  .resize(512, 512)
  .png()
  .toBuffer();
writeFileSync(join(staging, 'launcher.png'), launcherPng);

// daemon 二进制：release 取 module/bin/，debug 取 module/bin-debug/
const binSrc = join(moduleDir, DEBUG ? 'bin-debug' : 'bin', 'pluskeyd');
const daemonSrc = join(root, 'src', 'pluskeyd.c');
if (existsSync(binSrc)) {
  mkdirSync(join(staging, 'bin'), { recursive: true });
  copyFileSync(binSrc, join(staging, 'bin', 'pluskeyd'));
  chmodSync(join(staging, 'bin', 'pluskeyd'), 0o755); // zip 里必须可执行，否则 service.sh 拒绝启动
  const binTime = statSync(binSrc).mtimeMs;
  const srcTime = statSync(daemonSrc).mtimeMs;
  if (binTime < srcTime) {
    const msg = `${binSrc.slice(root.length + 1)} 比 src/pluskeyd.c 旧，包内 daemon 可能过期！请先重新编译 daemon。`;
    if (STRICT) fatal(msg);
    console.warn('[WARN] ' + msg);
  }
} else {
  const msg = `${binSrc.slice(root.length + 1)} 不存在，包内没有 daemon，装上后模块无法工作！请先编译 daemon（pnpm build:daemon${DEBUG ? ' -- --debug' : ''}）。`;
  if (STRICT) fatal(msg);
  console.warn('[WARN] ' + msg);
}

// 归一化换行符：Windows 检出（core.autocrlf=true）会把 .sh 变成 CRLF，
// 而 CRLF 的 shebang 与 `[ "$x" != "0" ]` 这类字符串比较在设备上直接失效
// （"0\r" 恒不等于 "0"）。入包前统一收敛为 LF，与 CI 的 Linux 检出结果一致。
const BINARY_FILES = new Set(['pluskeyd', 'launcher.png']);
function normalizeEol(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      normalizeEol(full);
      continue;
    }
    if (BINARY_FILES.has(entry.name)) continue;
    const text = readFileSync(full, 'utf-8');
    const lf = text.replace(/\r\n/g, '\n');
    if (lf !== text) {
      writeFileSync(full, lf);
      console.log(`[EOL] ${full.slice(staging.length + 1)} CRLF -> LF`);
    }
  }
}
normalizeEol(staging);

// ---------- 2. 读取版本号 ----------
const prop = readFileSync(join(moduleDir, 'module.prop'), 'utf-8');
const field = k => (prop.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim();
const id = field('id') || 'OPlusKey';
const version = field('version') || 'unknown';

// ---------- 3. 打 zip ----------
console.log('[2/3] 生成 zip...');
const suffix = DEBUG ? '-debug' : '';
const zipName = `${id}-${version}${suffix}.zip`;
const zipPath = join(distDir, zipName);
const output = createWriteStream(zipPath);
const archive = new ZipArchive({ zlib: { level: 9 } });
archive.pipe(output);

// Windows 的 stat 没有 POSIX 权限位（恒为 666），必须逐条目显式指定 mode，
// 否则刷入后 bin/pluskeyd 不可执行，service.sh 会拒绝启动
const EXEC_FILES = new Set(['service.sh', 'restart.sh', 'uninstall.sh', 'update-binary', 'customize.sh', 'pluskeyd']);
function addDir(dir, base = '') {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    const rel = base ? `${base}/${name.name}` : name.name;
    if (name.isDirectory()) {
      addDir(full, rel);
    } else {
      archive.append(createReadStream(full), {
        name: rel,
        mode: EXEC_FILES.has(name.name) ? 0o755 : 0o644,
      });
    }
  }
}
addDir(staging);

await archive.finalize();
await new Promise((resolve, reject) => {
  output.on('close', resolve);
  output.on('error', reject);
});
rmSync(staging, { recursive: true, force: true });

// 固定名副本：只给 release 生成，模块管理器的 updateJson 指向它做自动更新。
// debug 是自用包，不参与自动更新，也就不生成 latest 别名（避免覆盖 release 的）。
if (!DEBUG) {
  copyFileSync(zipPath, join(distDir, `${id}-latest.zip`));
}

console.log('[3/3] 完成');
console.log(`\n变体: ${VARIANT}${DEBUG ? '（含日志与 WebUI 调试面板）' : '（无日志）'}`);
console.log(`产物: dist/${zipName} (${(statSync(zipPath).size / 1024).toFixed(1)} KB)`);
if (!DEBUG) {
  console.log(`      dist/${id}-latest.zip（自动更新用，文件名固定）`);
}
console.log('包内结构: module.prop, 脚本, META-INF/, webroot/, bin/');
console.log('不含: src/, 源码, 构建脚本, node_modules');
