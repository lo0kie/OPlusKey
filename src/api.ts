// KernelSU / MMRL exec 桥接层 + 模块路径解析 + 调试日志
// 移植自旧版单文件 index.html，检测逻辑保持一致

export const MODDIR = (() => {
  try {
    const path = decodeURIComponent(location.pathname);
    const idx = path.indexOf('/webroot/');
    if (idx > 0 && path.startsWith('/data/adb/modules/')) {
      return path.slice(0, idx);
    }
  } catch {
    /* ignore */
  }
  return '/data/adb/modules/OPlusKey';
})();

// 配置放在模块目录之外：更新模块会重建模块目录，放里面会被刷掉
export const DATA_DIR = '/data/adb/OPlusKey';
export const CONFIG = `${DATA_DIR}/config.conf`;
export const DEBUG = `${DATA_DIR}/webui-debug.log`;
export const CONFIG_DIR = DATA_DIR;
export const LOGFILE = `${MODDIR}/pluskey.log`;

type ExecFn = (cmd: string) => Promise<unknown>;

let ksuExec: ExecFn | null = null;
let ksuApiName: string | null = null;

export function hasExec(): boolean {
  return ksuExec !== null;
}

export function getApiName(): string {
  return ksuApiName ?? 'unknown';
}

const started = Date.now();
const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

export function uiLog(msg: string): void {
  const line = `[${((Date.now() - started) / 1000).toFixed(3)}s] ${msg}`;
  const box = $('log');
  box.hidden = false;
  box.textContent += (box.textContent ? '\n' : '') + line;
  console.log('[PlusKey]', line);
}

export function setStatus(text: string, ok = true): void {
  $('statusText').textContent = text;
  $('dot').className = 'dot ' + (ok ? 'ok' : 'bad');
  uiLog('STATUS ' + text);
}

function bindExec(fn: unknown, name: string, owner: unknown = null): ExecFn | null {
  if (typeof fn !== 'function') return null;
  uiLog('发现 KernelSU exec API：' + name);
  const bound = (fn as (this: unknown, ...a: unknown[]) => unknown).bind(owner ?? window);
  return (cmd: string) => bound(cmd) as Promise<unknown>;
}

export async function loadKsuApi(): Promise<boolean> {
  uiLog('开始检测 KernelSU WebUI API');
  const objects: Array<[string, unknown]> = [
    ['ksu', (window as never as Record<string, unknown>).ksu],
    ['KernelSU', (window as never as Record<string, unknown>).KernelSU],
    ['kernelSU', (window as never as Record<string, unknown>).kernelSU],
    ['KSU', (window as never as Record<string, unknown>).KSU],
    ['kernelsu', (window as never as Record<string, unknown>).kernelsu],
  ];
  for (const [name, obj] of objects) {
    const o = obj as Record<string, unknown> | undefined;
    if (o && typeof o.exec === 'function') {
      ksuExec = bindExec(o.exec, name + '.exec', o);
      ksuApiName = name;
      return true;
    }
  }
  if (typeof (window as never as Record<string, unknown>).exec === 'function') {
    ksuExec = bindExec((window as never as Record<string, unknown>).exec, 'window.exec');
    ksuApiName = 'window.exec';
    return true;
  }
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    const ksu = g.ksu as Record<string, unknown> | undefined;
    if (ksu && typeof ksu.exec === 'function') {
      ksuExec = bindExec(ksu.exec, 'globalThis.ksu.exec', ksu);
      ksuApiName = 'globalThis.ksu';
      return true;
    }
  } catch (e) {
    uiLog('globalThis 检查失败：' + String(e));
  }
  uiLog('未发现 KernelSU WebUI exec API');
  return false;
}

export async function ensureApi(): Promise<void> {
  if (!ksuExec && !(await loadKsuApi())) {
    throw new Error('KernelSU exec API 尚未就绪');
  }
}

export function withTimeout<T>(promise: Promise<T> | PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('命令超时 ' + ms + 'ms')), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export interface ExecResult {
  errno: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string, timeout = 2500): Promise<string> {
  await ensureApi();
  uiLog(`EXEC [${getApiName()}] ${cmd}`);
  let raw: unknown;
  try {
    raw = await withTimeout(ksuExec!(cmd), timeout);
  } catch (e) {
    uiLog('EXEC THROW ' + String(e));
    throw e;
  }
  let result: ExecResult;
  if (typeof raw === 'string') {
    result = { errno: 0, stdout: raw, stderr: '' };
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    result = {
      errno: Number(o.errno ?? 0),
      stdout: String(o.stdout ?? ''),
      stderr: String(o.stderr ?? ''),
    };
  } else {
    result = { errno: 0, stdout: '', stderr: '' };
  }
  uiLog(
    `EXEC RESULT errno=${JSON.stringify(result.errno)} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
  );
  if (result.errno !== 0) throw new Error(result.stderr || '命令执行失败，errno=' + result.errno);
  return result.stdout;
}

export function quote(s: string): string {
  return String(s).replace(/'/g, "'\\''");
}

export function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export async function writeDebugFile(extra: string): Promise<void> {
  if (!ksuExec) return;
  const txt = [
    '==================================================',
    'OPlusKey WebUI Debug',
    'timestamp=' + new Date().toISOString(),
    'api=' + getApiName(),
    '==================================================',
    extra,
    '',
  ].join('\n');
  try {
    const encoded = b64(txt);
    await withTimeout(
      ksuExec(`mkdir -p '${quote(CONFIG_DIR)}' && printf '%s' '${encoded}' | base64 -d > '${quote(DEBUG)}'`),
      2500
    );
    uiLog('debug file written: ' + DEBUG);
  } catch (e) {
    uiLog('debug file write failed: ' + String(e));
  }
}
