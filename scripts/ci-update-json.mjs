// 生成模块管理器的 update.json（Magisk / KernelSU 自动更新的元数据）
// 用法: node scripts/ci-update-json.mjs [--dry-run]
//
// 版本号全部取自 module/module.prop——发版不依赖 git tag。
// 先用 scripts/ci-version.mjs 校验版本，本脚本只负责把它写成管理器要的 JSON。
//
// 为什么需要这个脚本：
//   module.prop 里的 updateJson 必须指向一个符合 Magisk ModuleJson 协议的文件：
//     { version, versionCode, zipUrl, changelog }
//   GitHub Releases API（api.github.com/repos/.../releases/latest）返回的是完全不同的
//   结构（tag_name / assets[] / body ...），管理器解析会抛 JsonDataException，
//   所以**不能**把 updateJson 直接指向 API。
//
//   这个 JSON 由 CI 在发版时生成为**临时构建产物**，作为 Release asset 上传
//   （不进仓库、不进模块 zip），管理器通过
//     releases/latest/download/update.json
//   稳定读取最新一版的元数据。
//
// zipUrl 用固定名 .../releases/latest/download/<id>-latest.zip，
// 该别名由 pack.mjs 只为 release 变体生成。
//
// changelog 必须是**能被管理器直接 HTTP 取回来的文件 URL**：
// 管理器拿到它会当场抓下来、按 Markdown 渲染进更新对话框。
// 所以它指向跟 zipUrl 同一层的 changelog.md（由 scripts/ci-changelog.mjs 生成、
// CI 上传为 Release asset），而不是仓库里的路径，也不是 API 的 body 字段。
// 这样用户在管理器里点「更新」时，看到的就是完整更新日志。

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');

function fail(msg) {
  console.error('[ERROR] ' + msg);
  process.exit(1);
}

// ---------- module.prop 是唯一的版本来源 ----------
const propPath = join(root, 'module', 'module.prop');
const prop = readFileSync(propPath, 'utf-8');
const field = k => (prop.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim();

const id = field('id');
const version = field('version');
const versionCode = Number(field('versionCode'));

if (!id) fail('module/module.prop 里没有 id=');
if (!version) fail('module/module.prop 里没有 version=');
if (!Number.isInteger(versionCode)) fail(`module.prop 的 versionCode 不是整数：${field('versionCode')}`);

// ---------- 仓库地址 ----------
// 优先取 CI 注入的环境变量，本地（无 CI）时从 git remote 推导，
// 避免把 owner/repo 在脚本里写死一份、module.prop 里再写一份。
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

const slug = repoSlug();
const base = slug ? `https://github.com/${slug}/releases` : '';
if (!DRY && !base)
  fail('无法推导仓库地址（GITHUB_REPOSITORY 未设置且 git remote 不可用），请用 --dry-run 或补上 remote');
// dry-run 且拿不到仓库地址时用占位符，便于本地看输出
const repoBase = base || 'https://github.com/<owner>/<repo>/releases';

const update = {
  version,
  versionCode,
  // 指向版本化的 zip，与 Release 里的文件名一致。
  // 不用固定名别名（如 OPlusKey-latest.zip）——那会让 Release 里多一个与版本化包
  // 内容完全相同的文件。走 /releases/latest/ 前缀，URL 本身就会随最新版变化。
  zipUrl: `${repoBase}/latest/download/${id}-${version}.zip`,
  // changelog 同样走 latest 别名：管理器会抓这个文件、渲染进更新对话框。
  // 内容来自 scripts/ci-changelog.mjs 生成的 changelog.md，CI 上传为 Release asset。
  changelog: `${repoBase}/latest/download/changelog.md`,
};

const out = JSON.stringify(update, null, 2) + '\n';
const outPath = join(root, 'dist', 'update.json');

if (DRY) {
  console.log('--- dist/update.json ---\n' + out);
} else {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(outPath, out);
  console.log(`[OK] update.json: version=${version} versionCode=${versionCode}`);
  console.log(`     zipUrl=${update.zipUrl}`);
  if (!existsSync(outPath)) fail('update.json 写入失败');
}
