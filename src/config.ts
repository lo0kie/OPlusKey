// 配置模型：按键定义、状态、解析与生成
// daemon 侧的解析见 src/pluskeyd.c 的 CFG_ENTRIES，两侧键名必须保持一致

export interface KeyDef {
  id: string;
  label: string;
  hint: string;
  keys: { enabled: string; single: string; double: string; long: string; longMs: string; repeat: string };
  defaults: { enabled: string; single: string; double: string; long: string; longMs: string; repeat: string };
}

export const KEY_DEFS: KeyDef[] = [
  {
    id: 'plus',
    label: '侧键',
    hint: '「无操作」即屏蔽原始按键。',
    keys: {
      enabled: 'plus_enabled',
      single: 'single',
      double: 'double',
      long: 'long',
      longMs: 'long_press_ms',
      repeat: 'long_repeat',
    },
    defaults: { enabled: '1', single: 'none', double: 'none', long: 'none', longMs: '600', repeat: '0' },
  },
  {
    id: 'power',
    label: '电源键',
    hint: '「保留原始按键」不拦截电源键；一旦配置双击或长按，单击会延迟到双击窗口结束，且长按连发会屏蔽系统电源长按菜单。',
    keys: {
      enabled: 'power_enabled',
      single: 'power_single',
      double: 'power_double',
      long: 'power_long',
      longMs: 'power_long_press_ms',
      repeat: 'power_long_repeat',
    },
    defaults: { enabled: '1', single: 'native', double: 'none', long: 'none', longMs: '800', repeat: '0' },
  },
  {
    id: 'vol_up',
    label: '音量加',
    hint: '「保留原始按键」时可长按连续调节音量；配置双击或长按后此特性失效。',
    keys: {
      enabled: 'vol_up_enabled',
      single: 'vol_up_single',
      double: 'vol_up_double',
      long: 'vol_up_long',
      longMs: 'vol_up_long_press_ms',
      repeat: 'vol_up_long_repeat',
    },
    defaults: { enabled: '1', single: 'native', double: 'none', long: 'none', longMs: '600', repeat: '0' },
  },
  {
    id: 'vol_down',
    label: '音量减',
    hint: '「保留原始按键」时可长按连续调节音量；配置双击或长按后此特性失效。',
    keys: {
      enabled: 'vol_down_enabled',
      single: 'vol_down_single',
      double: 'vol_down_double',
      long: 'vol_down_long',
      longMs: 'vol_down_long_press_ms',
      repeat: 'vol_down_long_repeat',
    },
    defaults: { enabled: '1', single: 'native', double: 'none', long: 'none', longMs: '600', repeat: '0' },
  },
];

export const GLOBAL_DEFAULTS: Record<string, string> = {
  double_click_ms: '300',
  long_repeat_interval_ms: '300',
  longpress_hold_ms: '3000',
  vibrate: '0',
};

export const DEFAULTS: Record<string, string> = (() => {
  const d: Record<string, string> = { ...GLOBAL_DEFAULTS };
  for (const def of KEY_DEFS) {
    d[def.keys.enabled] = def.defaults.enabled;
    d[def.keys.single] = def.defaults.single;
    d[def.keys.double] = def.defaults.double;
    d[def.keys.long] = def.defaults.long;
    d[def.keys.longMs] = def.defaults.longMs;
    d[def.keys.repeat] = def.defaults.repeat;
  }
  return d;
})();

export const state: Record<string, string> = { ...DEFAULTS };

export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function buildConfigText(): string {
  const lines = [
    '# OPlusKey Remapper',
    `double_click_ms=${clampNum(state.double_click_ms, 100, 2000, 300)}`,
    `long_repeat_interval_ms=${clampNum(state.long_repeat_interval_ms, 50, 5000, 300)}`,
    `longpress_hold_ms=${clampNum(state.longpress_hold_ms, 500, 10000, 3000)}`,
    `vibrate=${state.vibrate === '1' ? '1' : '0'}`,
    '',
  ];
  for (const def of KEY_DEFS) {
    lines.push(
      `# ${def.label}`,
      `${def.keys.enabled}=${state[def.keys.enabled] === '0' ? '0' : '1'}`,
      `${def.keys.longMs}=${clampNum(state[def.keys.longMs], 100, 10000, Number(def.defaults.longMs))}`,
      `${def.keys.single}=${state[def.keys.single] || 'none'}`,
      `${def.keys.double}=${state[def.keys.double] || 'none'}`,
      `${def.keys.long}=${state[def.keys.long] || 'none'}`,
      `${def.keys.repeat}=${state[def.keys.repeat] === '1' ? '1' : '0'}`,
      ''
    );
  }
  return lines.join('\n');
}

export function parse(txt: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function applyParsedConfig(parsed: Record<string, string>): void {
  for (const key of Object.keys(DEFAULTS)) {
    state[key] = parsed[key] ?? DEFAULTS[key];
  }
}

export function makeDefaultConfig(): string {
  return buildConfigText();
}
