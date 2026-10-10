// 配置模型：按键定义、状态、解析与生成
// daemon 侧的解析见 src/pluskeyd.c 的 CFG_ENTRIES，两侧键名必须保持一致

export interface KeyDef {
  id: string;
  label: string;
  hint: string;
  keys: {
    enabled: string;
    single: string;
    double: string;
    long: string;
    longMs: string;
    repeat: string;
    repeatInterval: string;
  };
  defaults: {
    enabled: string;
    single: string;
    double: string;
    long: string;
    longMs: string;
    repeat: string;
    repeatInterval: string;
  };
}

export const KEY_DEFS: KeyDef[] = [
  {
    id: 'plus',
    label: '侧键',
    hint: '「无操作」即屏蔽原始按键。',
    keys: {
      enabled: 'plus_enabled',
      single: 'plus_single',
      double: 'plus_double',
      long: 'plus_long',
      longMs: 'plus_long_press_ms',
      repeat: 'plus_long_repeat',
      repeatInterval: 'plus_long_repeat_interval_ms',
    },
    defaults: {
      enabled: '0',
      single: 'native',
      double: 'none',
      long: 'none',
      longMs: '500',
      repeat: '0',
      repeatInterval: '300',
    },
  },
];

/* 配置格式版本：与 src/pluskeyd.c 的 CONFIG_VERSION 必须一致。
 * daemon 启动时会校验，不匹配直接覆写为新配置。 */
export const CONFIG_VERSION = 2;

export const GLOBAL_DEFAULTS: Record<string, string> = {
  double_click_ms: '300',
  long_repeat_interval_ms: '300',
  vibrate: '0',
};

/* 取值范围：与 src/pluskeyd.c 的 MIN_/MAX_ 宏一一对应，改这里必须同步改 C 侧 */
export const LIMITS = {
  longMs: { min: 100, max: 10000 },
  repeatInterval: { min: 100, max: 5000 },
  doubleClickMs: { min: 100, max: 2000 },
} as const;

export const DEFAULTS: Record<string, string> = (() => {
  const d: Record<string, string> = { ...GLOBAL_DEFAULTS };
  for (const def of KEY_DEFS) {
    d[def.keys.enabled] = def.defaults.enabled;
    d[def.keys.single] = def.defaults.single;
    d[def.keys.double] = def.defaults.double;
    d[def.keys.long] = def.defaults.long;
    d[def.keys.longMs] = def.defaults.longMs;
    d[def.keys.repeat] = def.defaults.repeat;
    d[def.keys.repeatInterval] = def.defaults.repeatInterval;
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
    `config_version=${CONFIG_VERSION}`,
    `double_click_ms=${clampNum(state.double_click_ms, LIMITS.doubleClickMs.min, LIMITS.doubleClickMs.max, 300)}`,
    `long_repeat_interval_ms=${clampNum(state.long_repeat_interval_ms, LIMITS.repeatInterval.min, LIMITS.repeatInterval.max, 300)}`,
    `vibrate=${state.vibrate === '1' ? '1' : '0'}`,
    '',
  ];
  for (const def of KEY_DEFS) {
    lines.push(
      `# ${def.label}`,
      `${def.keys.enabled}=${state[def.keys.enabled] === '0' ? '0' : '1'}`,
      `${def.keys.longMs}=${clampNum(state[def.keys.longMs], LIMITS.longMs.min, LIMITS.longMs.max, Number(def.defaults.longMs))}`,
      `${def.keys.single}=${state[def.keys.single] || 'none'}`,
      `${def.keys.double}=${state[def.keys.double] || 'none'}`,
      `${def.keys.long}=${state[def.keys.long] || 'none'}`,
      `${def.keys.repeat}=${state[def.keys.repeat] === '1' ? '1' : '0'}`,
      `${def.keys.repeatInterval}=${clampNum(state[def.keys.repeatInterval], LIMITS.repeatInterval.min, LIMITS.repeatInterval.max, 300)}`,
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
