// 生成 changelog.md（给模块管理器的更新对话框用）
// 用法: node scripts/ci-changelog.mjs [--dry-run]   # 累积全部（默认）
//       node scripts/ci-changelog.mjs --current     # 只输出 module.prop 里那一版
//
// 背景：管理器（Magisk / KernelSU）更新模块时，会去读 update.json 的 changelog 字段，
// 把那个 URL 抓下来当 Markdown 渲染。所以 changelog 必须是**一个可直接 HTTP 取到的文件**，
// 不能是仓库里的某个路径（管理器不认 GitHub 网页），也不能是 API 返回的 body。
//
// 因此这里把 changelog/ 下的分版本 markdown 按版本从新到旧拼成一份 changelog.md，
// 由 CI 上传为 Release asset，update.json 的 changelog 指向
//   .../releases/latest/download/changelog.md
// 管理器就能在更新对话框里直接看到完整更新日志。
//
// 版本来源是 module/module.prop（发版不依赖 git tag）。
//
// 为什么默认累积而非只放当前版本：update.json 里没有"上一版是什么"的信息，
// 管理器也不会告诉服务端用户现在装的是哪版。累积全文是唯一能让所有用户
// （无论从哪个版本升上来）都看到自己所跨版本变更的做法。

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const CURRENT_ONLY = args.includes('--current');

const dir = join(root, 'changelog');

function fail(msg) {
  console.error('[ERROR] ' + msg);
  process.exit(1);
}

/// 语义化版本比较：主 → 次 → 修订 → 是否正式版（正式 > beta）。返回 <0 表示 a 比 b 旧。
function compareVersion(a, b) {
  const parse = v => {
    const [, core, pre = ''] = v.match(/^v?(\d+\.\d+\.\d+)(?:-(.*))?$/) ?? [];
    if (!core) return null;
    const [major, minor, patch] = core.split('.').map(Number);
    return { major, minor, patch, prerelease: pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) fail(`无法解析版本号：${!pa ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] - pb[k];
  }
  // 同号时 beta < 正式
  const rank = p => (p.prerelease ? 0 : 1);
  return rank(pa) - rank(pb);
}

if (!existsSync(dir)) fail('changelog/ 目录不存在');
const files = readdirSync(dir).filter(f => f.endsWith('.md'));
if (!files.length) fail('changelog/ 里没有任何 .md，先在开发时随手记一份再发版');

// 每个文件名即版本号：v1.0.4-beta.md -> v1.0.4-beta
const entries = files.map(f => ({ version: f.replace(/\.md$/, ''), path: join(dir, f) }));

// 当前版本从 module.prop 读——发版不依赖 git tag
const prop = readFileSync(join(root, 'module', 'module.prop'), 'utf-8');
const current = (prop.match(/^version=(.*)$/m)?.[1] ?? '').trim();
if (!current) fail('module/module.prop 里没有 version=');

if (CURRENT_ONLY && !entries.some(e => e.version === current)) {
  fail(`changelog/${current}.md 不存在，发版前请先写这一版的更新日志`);
}

const selected = CURRENT_ONLY ? entries.filter(e => e.version === current) : entries;

// 从新到旧：用户最关心刚升上来的这版
selected.sort((a, b) => compareVersion(b.version, a.version));

const header = CURRENT_ONLY
  ? ''
  : '> 本文件由 `scripts/ci-changelog.mjs` 从 `changelog/` 自动生成，按版本从新到旧排列。\n' +
    '> 在 `changelog/<版本>.md` 里写每个版本的更新日志，发版时无需手工维护本文件。\n\n';

const body = selected.map(e => readFileSync(e.path, 'utf-8').trimEnd()).join('\n\n');
const out = header + body + '\n';
const outPath = join(root, 'changelog.md');

if (DRY) {
  console.log(`--- changelog.md（${selected.length} 个版本：${selected.map(e => e.version).join(', ')}）---\n`);
  console.log(out);
} else {
  mkdirSync(root, { recursive: true });
  writeFileSync(outPath, out);
  console.log(`[OK] changelog.md：${selected.length} 个版本（${selected.map(e => e.version).join(', ')}）`);
  console.log(`     字节数 ${Buffer.byteLength(out, 'utf-8')}`);
}
