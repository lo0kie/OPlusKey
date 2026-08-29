// daemon 交叉编译脚本：src/pluskeyd.c → module/bin/pluskeyd
// 用法: pnpm build:daemon
// 工具链探测顺序：
//   1. 环境变量 ANDROID_NDK_HOME / ANDROID_NDK / NDK_HOME
//   2. %LOCALAPPDATA%/Android/Sdk/ndk/*（Windows 默认 SDK 位置，取最新版本）

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'pluskeyd.c');
const out = join(root, 'module', 'bin', 'pluskeyd');
const API = 35; // android35：OnePlus 15 / Android 15+

function findNdk() {
  const envCandidates = [process.env.ANDROID_NDK_HOME, process.env.ANDROID_NDK, process.env.NDK_HOME].filter(Boolean);
  for (const c of envCandidates) {
    if (existsSync(c)) return c;
  }
  const sdk = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'ndk') : null;
  if (sdk && existsSync(sdk)) {
    const versions = readdirSync(sdk)
      .filter(v => existsSync(join(sdk, v, 'toolchains')))
      .sort((a, b) => statSync(join(sdk, b)).mtimeMs - statSync(join(sdk, a)).mtimeMs);
    if (versions.length > 0) return join(sdk, versions[0]);
  }
  return null;
}

function findClang(ndk) {
  const pre = ['windows-x86_64', 'linux-x86_64', 'darwin-x86_64'].map(host =>
    join(ndk, 'toolchains', 'llvm', 'prebuilt', host, 'bin')
  );
  for (const bin of pre) {
    for (const exe of [`aarch64-linux-android${API}-clang.cmd`, `aarch64-linux-android${API}-clang`]) {
      const p = join(bin, exe);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const ndk = findNdk();
if (!ndk) {
  console.error('[ERROR] 未找到 Android NDK。请安装 NDK（含 CMake），或设置 ANDROID_NDK_HOME 环境变量。');
  console.error('        也可以在设备上用 Termux 运行 module/build.sh 编译。');
  process.exit(1);
}
const clang = findClang(ndk);
if (!clang) {
  console.error(`[ERROR] NDK 里没找到 aarch64-linux-android${API}-clang: ${ndk}`);
  process.exit(1);
}

mkdirSync(join(root, 'module', 'bin'), { recursive: true });
const args = ['-O2', '-Wall', '-Wextra', '-s', src, '-o', out + '.tmp'];
console.log(`[BUILD] ${clang}`);
console.log(`[BUILD] ${args.join(' ')}`);
const r = spawnSync(clang, args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) {
  console.error(`[ERROR] 编译失败，exit=${r.status}`);
  process.exit(r.status ?? 1);
}
copyFileSync(out + '.tmp', out);
unlinkSync(out + '.tmp');
const size = (statSync(out).size / 1024).toFixed(1);
console.log(`\n[OK] module/bin/pluskeyd (${size} KB, aarch64 android${API})`);
