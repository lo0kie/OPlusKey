// 发版前的版本校验：以 module/module.prop 为唯一版本来源
// 用法: node scripts/ci-version.mjs [--dry-run] [--no-remote]
//
// 背景：发版不再依赖 git tag。版本号在 module/module.prop 里手动维护，
// 这个脚本负责在构建前把它核对干净，避免发出错版。
//
// 它检查三件事：
//   1. version 形如 v主.次.修订（可选 -后缀），versionCode 与之一致
//      （versionCode = 主×100000 + 次×1000 + 修订，管理器靠它比对大小）
//   2. changelog/<version>.md 已写好——管理器会把它展示给用户
//   3. 相比线上最新 Release 的版本没有倒退（查不到就跳过，不阻塞构建）
//
// update.json 与 changelog.md 由各自的脚本生成，见 scripts/ci-update-json.mjs /
// scripts/ci-changelog.mjs。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_REMOTE = args.includes('--no-remote');

function fail(msg) {
  console.error('[ERROR] ' + msg);
  process.exit(1);
}
const warn = msg => console.warn('[WARN] ' + msg);

// 仓库 slug：优先 CI 环境变量，本地从 git remote 推导
function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf-8' }).trim();
    return url
      .replace(/^git@github\.com:/, '')
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/\.git$/, '');
  } catch {
    return '';
  }
}

// ---------- 1. 从 module.prop 读版本 ----------
const propPath = join(root, 'module', 'module.prop');
const prop = readFileSync(propPath, 'utf-8');
const field = k => (prop.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim();

const version = field('version');
const versionCodeRaw = field('versionCode');
if (!version) fail('module/module.prop 里没有 version=');
if (!versionCodeRaw) fail('module/module.prop 里没有 versionCode=');

const m = version.match(/^v(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
if (!m) fail(`version 必须形如 v主.次.修订 或 v主.次.修订-后缀（如 v1.0.0、v1.1.0-beta），当前：${version}`);

const [, sMajor, sMinor, sPatch] = m;
const [major, minor, patch] = [sMajor, sMinor, sPatch].map(Number);
const expectedCode = major * 100000 + minor * 1000 + patch;
const versionCode = Number(versionCodeRaw);

if (!Number.isInteger(versionCode)) fail(`versionCode 不是整数：${versionCodeRaw}`);
if (versionCode !== expectedCode) {
  fail(
    `versionCode 与 version 不匹配：${version} 应为 ${expectedCode}，当前 ${versionCode}\n` +
      `        公式：主×100000 + 次×1000 + 修订`
  );
}

// ---------- 2. 这一版的更新日志必须已写好 ----------
const entry = join(root, 'changelog', `${version}.md`);
if (!existsSync(entry)) {
  fail(
    `changelog/${version}.md 不存在。\n` +
      `        请在 changelog/ 下写清楚这一版改了什么（管理器会把它展示给用户），再发版。`
  );
}
if (!readFileSync(entry, 'utf-8').trim()) {
  fail(`changelog/${version}.md 是空的，请写点内容再发版。`);
}

// ---------- 3. 不允许版本倒退 ----------
// 拿线上最新 Release 的 update.json 比对（它是权威的“当前已发布版本”）。
// 查不到就跳过——网络问题不该阻塞构建，真正防错的是管理器那边按 versionCode 比对。
if (!NO_REMOTE) {
  const slug = repoSlug();
  if (!slug) {
    warn('推导不出仓库地址，跳过版本倒退检查');
  } else {
    const url = `https://github.com/${slug}/releases/latest/download/update.json`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.status === 404) {
        console.log('     线上还没有 Release，跳过倒退检查');
      } else if (!res.ok) {
        warn(`拉取线上 update.json 失败（HTTP ${res.status}），跳过倒退检查`);
      } else {
        const published = await res.json();
        if (typeof published.versionCode === 'number' && versionCode <= published.versionCode) {
          fail(
            `版本没有前进：当前 ${version}(${versionCode}) 不大于线上最新版 ` +
              `${published.version}(${published.versionCode})。\n` +
              `        请把 module.prop 的 version / versionCode 往上加再推。`
          );
        }
        console.log(`     线上最新版 ${published.version}(${published.versionCode})，本次 ${version}(${versionCode}) ✓`);
      }
    } catch (e) {
      warn(`版本倒退检查失败（已跳过）：${e.message}`);
    }
  }
}

// ---------- 输出 ----------
console.log(`[OK] version=${version} versionCode=${versionCode}`);
console.log(`     changelog/${version}.md 已就位`);
if (DRY) console.log('     （--dry-run，未改动任何文件）');
