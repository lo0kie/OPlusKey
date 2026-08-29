// MD3 动态色彩。
// KernelSU 管理器通过 internal/colors.css 注入系统 Monet 变量（--primary 等）。
// 注意：注入的是管理器当前主题的整套色板，明暗可能与本页不一致，
// 因此只取 --primary 的色相（HCT），按本页暗色方案的亮度等级重生成强调色，
// 页面表面色/明暗完全不受影响。未注入时保持默认令牌。

import { Hct, hexFromArgb } from '@material/material-color-utilities';

/* 已写入的内联 --md-* 变量，关闭取色时清除 */
let inlineKeys: string[] = [];

function clearInlineVars(): void {
  const style = document.documentElement.style;
  for (const key of inlineKeys) style.removeProperty(key);
  inlineKeys = [];
}

function parseCssColor(v: string): number | null {
  let h = v.replace('#', '').trim();
  if (h.length === 8) h = h.slice(0, 6); // #rrggbbaa → 取 rgb
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  return Number.isNaN(n) ? null : (0xff000000 | n) >>> 0;
}

/* 从注入的 --primary 提取色相，重生成暗色方案的强调色组 */
export function applyTheme(opts: { monet: boolean }): void {
  const rootEl = document.documentElement;
  const style = rootEl.style;
  clearInlineVars();
  if (!opts.monet) return;

  const injected = getComputedStyle(rootEl).getPropertyValue('--primary').trim();
  const argb = injected ? parseCssColor(injected) : null;
  if (argb === null) return;

  const hct = Hct.fromInt(argb);
  const at = (tone: number): string => hexFromArgb(Hct.from(hct.hue, hct.chroma, tone).toInt());
  const set = (name: string, value: string): void => {
    const prop = `--md-${name}`;
    style.setProperty(prop, value);
    inlineKeys.push(prop);
  };

  set('primary', at(80));
  set('on-primary', at(20));
  set('primary-container', at(30));
  set('on-primary-container', at(90));
  set('secondary', at(80));
  set('on-secondary', at(20));
  set('secondary-container', at(30));
  set('on-secondary-container', at(90));
}

/* 检测管理器是否注入了系统色 */
export function hasSystemPrimary(): boolean {
  return getComputedStyle(document.documentElement).getPropertyValue('--primary').trim().length > 0;
}
