// 模块打包脚本：产出可直接刷入的模块 zip（不含任何源码）
// 用法: pnpm pack:module
//   先跑 pnpm build 生成 webroot/，然后组装 module/ 下的模块内容:
//     module.prop / service.sh / restart.sh / uninstall.sh / skip_mount
//     META-INF/ + config/config.conf + webroot/ + bin/pluskeyd
//   打包为 dist/<id>-<version>.zip

import { ZipArchive } from 'archiver';
import { spawnSync } from 'node:child_process';
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
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const moduleDir = join(root, 'module');
const distDir = join(root, 'dist');
const staging = join(distDir, 'module');

// ---------- 1. 构建 WebUI ----------
console.log('[1/4] 构建 WebUI (pnpm build)...');
const build = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.status !== 0) {
  console.error('[ERROR] WebUI 构建失败');
  process.exit(1);
}

// ---------- 2. 组装暂存目录 ----------
console.log('[2/4] 组装模块文件...');
// 只清暂存目录，不动 dist/ 本身（避免 zip 被占用时清理失败，也保留历史包）
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(join(staging, 'META-INF', 'com', 'google', 'android'), { recursive: true });
mkdirSync(join(staging, 'config'), { recursive: true });

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
// 默认配置
copyFileSync(join(moduleDir, 'config', 'config.conf'), join(staging, 'config', 'config.conf'));
// WebUI 构建产物（vite 输出到 dist/webroot）
cpSync(join(root, 'dist', 'webroot'), join(staging, 'webroot'), { recursive: true });

// daemon 二进制：C 构建产物，位于 module/bin/；检查存在性与新鲜度
const binSrc = join(moduleDir, 'bin', 'pluskeyd');
const daemonSrc = join(root, 'src', 'pluskeyd.c');
if (existsSync(binSrc)) {
  mkdirSync(join(staging, 'bin'), { recursive: true });
  copyFileSync(binSrc, join(staging, 'bin', 'pluskeyd'));
  chmodSync(join(staging, 'bin', 'pluskeyd'), 0o755); // zip 里必须可执行，否则 service.sh 拒绝启动
  const binTime = statSync(binSrc).mtimeMs;
  const srcTime = statSync(daemonSrc).mtimeMs;
  if (binTime < srcTime) {
    console.warn('[WARN] module/bin/pluskeyd 比 src/pluskeyd.c 旧，包内 daemon 可能过期！');
    console.warn('       请先重新编译 daemon 后再打包。');
  }
} else {
  console.warn('[WARN] module/bin/pluskeyd 不存在，包内没有 daemon，装上后模块无法工作！');
  console.warn('       请先编译 daemon（设备 build.sh 或 NDK 交叉编译）。');
}

// ---------- 3. 读取版本号 ----------
const prop = readFileSync(join(moduleDir, 'module.prop'), 'utf-8');
const field = k => (prop.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim();
const id = field('id') || 'OPlusKey';
const version = field('version') || 'unknown';

// ---------- 4. 打 zip ----------
console.log('[3/4] 生成 zip...');
const zipName = `${id}-${version}.zip`;
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

// 固定名副本：update.json 的 zipUrl 指向 releases/latest/download/OPlusKey-latest.zip
copyFileSync(zipPath, join(distDir, `${id}-latest.zip`));

console.log('[4/4] 完成');
console.log(`\n产物: dist/${zipName} (${(statSync(zipPath).size / 1024).toFixed(1)} KB)`);
console.log(`      dist/${id}-latest.zip（自动更新用，文件名固定）`);
console.log('包内结构: module.prop, 脚本, META-INF/, config/, webroot/, bin/');
console.log('不含: src/, 源码, 构建脚本, node_modules');
