import {
  CONFIG,
  CONFIG_DIR,
  LOGFILE,
  MODDIR,
  b64,
  ensureApi,
  getApiName,
  hasExec,
  quote,
  run,
  setStatus,
  uiLog,
  writeDebugFile,
} from './api';
import { KEY_DEFS, applyParsedConfig, buildConfigText, makeDefaultConfig, parse, state } from './config';
import './style.css';
import { applyTheme, hasSystemPrimary } from './theme';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
const $input = (id: string): HTMLInputElement => $(id) as HTMLInputElement;

window.addEventListener('error', e => {
  uiLog(`JS ERROR: ${e.message || e.error || 'unknown'} @ ${e.filename || ''}:${e.lineno || ''}`);
  setStatus('JavaScript 错误，请查看诊断日志', false);
});

window.addEventListener('unhandledrejection', e => {
  uiLog(`PROMISE ERROR: ${e.reason?.stack || e.reason || 'unknown'}`);
  setStatus('异步错误，请查看诊断日志', false);
});

uiLog('HTML/JS 开始执行');

// ---------- 动作预设 ----------

// [值, Material Symbols 图标名, 显示文本]
const actionPresets: Array<[string, string, string]> = [
  ['none', 'block', '无操作'],
  ['native', 'settings_backup_restore', '保留原始按键'],
  ['passthrough', 'double_arrow', '延迟转发按键'],
  ['shell:[ "$(cat /sys/class/leds/white:flash-1/brightness)" -gt 0 ] && (echo none > /sys/class/leds/white:flash-1/trigger; echo 0 > /sys/class/leds/white:flash-1/brightness) || (echo torch > /sys/class/leds/white:flash-1/trigger; echo 200 > /sys/class/leds/white:flash-1/brightness)',
    'flashlight_on',
    '手电筒',
  ],
  ['service call color_screenshot 1', 'screenshot', '截图'],
  ['intent:android.media.action.STILL_IMAGE_CAMERA', 'photo_camera', '打开相机'],
  ['keyevent:KEYCODE_POWER', 'lock', '锁屏 / 电源'],
  ['keyevent:223', 'dark_mode', '熄屏'],
  ['keyevent:KEYCODE_VOLUME_MUTE', 'volume_off', '静音'],
  ['keyevent:KEYCODE_HOME', 'home', 'Home'],
  ['keyevent:KEYCODE_BACK', 'arrow_back', '返回'],
  ['keyevent:KEYCODE_APP_SWITCH', 'layers', '最近任务'],
  ['keyevent:KEYCODE_NOTIFICATION', 'notifications', '通知栏'],
  ['keyevent:KEYCODE_MEDIA_PLAY_PAUSE', 'play_pause', '播放 / 暂停'],
  ['keyevent:KEYCODE_VOLUME_UP', 'volume_up', '音量 +'],
  ['keyevent:KEYCODE_VOLUME_DOWN', 'volume_down', '音量 -'],
  [
    'shell:am start-foreground-service -a oplus.intent.action.DIRECT_SIDEBAR_SERVICE -e extra_entrance_function full_screen_ocr -e triggered_app com.coloros.smartsidebar',
    'center_focus_strong',
    '小布识屏',
  ],
  ['custom', 'edit', '自定义'],
];

// ---------- 通用选择器 ----------

interface Picker {
  set(v: string): void;
  get(): string;
}

function makePicker(
  host: HTMLElement,
  items: Array<[string, string, string]>,
  value: string,
  onChange: (v: string) => void
): Picker {
  host.innerHTML =
    '<button type="button" class="picker-button" aria-haspopup="listbox"><span class="picker-label"></span><span class="chevron"></span></button><div class="menu" role="listbox"></div>';
  const button = host.querySelector('.picker-button') as HTMLButtonElement;
  const label = host.querySelector('.picker-label') as HTMLElement;
  const menu = host.querySelector('.menu') as HTMLElement;
  const itemHtml = (item: [string, string, string]): string =>
    `<span class="msr">${item[1]}</span><span class="option-label">${item[2]}</span>`;
  const render = (v: string): void => {
    const item = items.find(x => x[0] === String(v)) || items[0];
    label.innerHTML = itemHtml(item);
    host.dataset.value = item[0];
    menu.querySelectorAll('.option').forEach(x => {
      (x as HTMLElement).classList.toggle('selected', (x as HTMLElement).dataset.v === item[0]);
    });
  };
  for (const item of items) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'option';
    el.dataset.v = item[0];
    el.innerHTML = itemHtml(item);
    el.addEventListener('click', e => {
      e.stopPropagation();
      render(item[0]);
      host.classList.remove('open');
      onChange(item[0]);
      uiLog(`PICK ${host.id}=${item[0]}`);
    });
    menu.appendChild(el);
  }
  button.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const wasOpen = host.classList.contains('open');
    document.querySelectorAll('.picker.open').forEach(x => x.classList.remove('open'));
    if (!wasOpen) {
      host.classList.add('open');
      uiLog('OPEN ' + host.id);
    }
  });
  render(value);
  return {
    set(v) {
      render(v);
    },
    get() {
      return host.dataset.value ?? '';
    },
  };
}

document.addEventListener('click', () => {
  document.querySelectorAll('.picker.open').forEach(x => x.classList.remove('open'));
});

// ---------- 动作选择器（每键 × 单击/双击/长按） ----------

interface ActionController {
  set(v: string): void;
  get(): string;
}

const actions: Record<string, ActionController> = {};

function makeAction(stateKey: string, title: string, host: HTMLElement, onStateChange?: () => void): ActionController {
  const root = document.createElement('div');
  root.className = 'action';
  root.innerHTML =
    '<div class="action-head"><span class="action-title">' +
    title +
    '</span></div><div class="picker" id="' +
    stateKey +
    'Picker"></div><div class="custom-wrap" id="' +
    stateKey +
    'Custom"><input id="' +
    stateKey +
    'Input" autocomplete="off" placeholder="例如 shell:cmd statusbar expand-notifications"></div>';
  host.appendChild(root);

  const picker = makePicker($(`${stateKey}Picker`), actionPresets, 'none', v => {
    if (v === 'custom') {
      // 进入自定义模式只打开输入框并预填当前值，不覆盖 state、不触发保存，
      // 否则空输入会把配置冲成 none 并在自动保存同步时把选择器弹回
      const cur = String(state[stateKey] ?? 'none');
      $input(`${stateKey}Input`).value = cur !== 'none' && !actionPresets.some(x => x[0] === cur) ? cur : '';
      render();
      onStateChange?.();
      return;
    }
    state[stateKey] = v;
    $input(`${stateKey}Input`).value = '';
    render();
    onStateChange?.();
    debouncedSave();
  });

  $input(`${stateKey}Input`).addEventListener('input', () => {
    if ($(`${stateKey}Picker`).dataset.value === 'custom') {
      state[stateKey] = $input(`${stateKey}Input`).value.trim() || 'none';
      render();
      onStateChange?.();
      debouncedSave();
    }
  });

  function render(): void {
    const pickerValue = $(`${stateKey}Picker`).dataset.value ?? '';
    const custom = pickerValue === 'custom';
    $(`${stateKey}Custom`).classList.toggle('show', custom);
  }

  return {
    set(v) {
      v = String(v ?? 'none');
      if (actionPresets.some(x => x[0] === v && x[0] !== 'custom')) {
        picker.set(v);
        $input(`${stateKey}Input`).value = '';
      } else if (v !== 'none') {
        picker.set('custom');
        $input(`${stateKey}Input`).value = v;
      } else {
        picker.set('none');
        $input(`${stateKey}Input`).value = '';
      }
      render();
    },
    get() {
      return state[stateKey];
    },
  };
}

// ---------- 按键卡片 ----------

interface KeyCardRefs {
  longMs: HTMLInputElement;
  repeat: HTMLInputElement;
  enabled: HTMLInputElement;
  body: HTMLElement;
  syncTimingRow(): void;
}

function buildKeyCard(def: (typeof KEY_DEFS)[number]): KeyCardRefs {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML =
    '<div class="key-head"><div class="section-title">' +
    def.label +
    '</div><label class="switch"><input id="' +
    def.id +
    'Enabled" type="checkbox" /><span class="switch-track"><span class="switch-thumb"></span></span></label></div>' +
    '<div id="' +
    def.id +
    'Body"><div id="' +
    def.id +
    'Actions"></div><div class="grid key-timing" id="' +
    def.id +
    'Timing"><div class="field"><label for="' +
    def.id +
    'LongMs">长按判定 (ms)</label><input id="' +
    def.id +
    'LongMs" type="text" inputmode="numeric" autocomplete="off" placeholder="' +
    def.defaults.longMs +
    '" /></div><div class="field switch-field"><label for="' +
    def.id +
    'Repeat">长按持续触发</label><div class="switch-slot"><label class="switch" for="' +
    def.id +
    'Repeat"><input id="' +
    def.id +
    'Repeat" type="checkbox" /><span class="switch-track"><span class="switch-thumb"></span></span></label></div></div></div><div class="hint">' +
    def.hint +
    '</div></div>';
  $('keyCards').appendChild(card);
  const host = $(def.id + 'Actions');
  actions[def.keys.single] = makeAction(def.keys.single, '单击', host);
  actions[def.keys.double] = makeAction(def.keys.double, '双击', host);
  // 长按动作为「无操作」时，长按判定/持续触发行无意义，随之隐藏
  actions[def.keys.long] = makeAction(def.keys.long, '长按', host, () => syncTimingRow());
  const longMs = $input(def.id + 'LongMs');
  const repeat = $input(def.id + 'Repeat');
  const enabled = $input(def.id + 'Enabled');
  const body = $(def.id + 'Body');
  longMs.addEventListener('input', () => {
    state[def.keys.longMs] = longMs.value.replace(/[^\d]/g, '');
    debouncedSave();
  });
  repeat.addEventListener('change', () => {
    state[def.keys.repeat] = repeat.checked ? '1' : '0';
    debouncedSave();
  });
  function syncBody(): void {
    body.style.display = enabled.checked ? '' : 'none';
  }
  function syncTimingRow(): void {
    $(def.id + 'Timing').style.display = is_action_none(state[def.keys.long]) ? 'none' : '';
  }
  enabled.addEventListener('change', () => {
    state[def.keys.enabled] = enabled.checked ? '1' : '0';
    syncBody();
    uiLog(def.id.toUpperCase() + ' ENABLED=' + state[def.keys.enabled]);
    debouncedSave();
  });
  syncBody();
  syncTimingRow();
  return { longMs, repeat, enabled, body, syncTimingRow };
}

/* 与 config.ts 的 is_action_none 语义一致：none 或空字符串 */
function is_action_none(v: string | undefined): boolean {
  return !v || v === 'none';
}

uiLog('开始构建按键配置卡片');
const cardRefs = new Map<string, KeyCardRefs>();
for (const def of KEY_DEFS) {
  cardRefs.set(def.id, buildKeyCard(def));
}

// ---------- 全局输入 ----------

const vibrateInput = $input('vibrateInput');
vibrateInput.addEventListener('change', () => {
  state.vibrate = vibrateInput.checked ? '1' : '0';
  uiLog('VIBRATE=' + state.vibrate);
  debouncedSave();
});

// Monet 取色：开启=消费 KSU 注入的系统色，关闭=默认配色
const monetInput = $input('monetInput');

function applyMonet(): void {
  uiLog('MONET=' + (monetInput.checked ? '1' : '0'));
  if (!monetInput.checked) {
    applyTheme({ monet: false });
    setStatus('默认配色');
    return;
  }
  applyTheme({ monet: true });
  if (hasSystemPrimary()) {
    setStatus('配色来源：KSU 系统取色');
  } else {
    applyTheme({ monet: false });
    setStatus('KSU 未注入系统色（检查 KSU 外观的动态取色设置），使用默认配色', false);
  }
}

monetInput.addEventListener('change', () => {
  localStorage.setItem('monet', monetInput.checked ? '1' : '0');
  applyMonet();
});

// ---------- 调试模式 ----------

const debugInput = $input('debugInput');

function applyDebug(): void {
  $('debugCard').hidden = !debugInput.checked;
}

debugInput.addEventListener('change', () => {
  localStorage.setItem('debug', debugInput.checked ? '1' : '0');
  applyDebug();
  uiLog('DEBUG=' + (debugInput.checked ? '1' : '0'));
});

function syncAllInputs(): void {
  vibrateInput.checked = state.vibrate === '1';
  monetInput.checked = localStorage.getItem('monet') !== '0';
  debugInput.checked = localStorage.getItem('debug') === '1';
  applyDebug();
  applyMonet();
  for (const def of KEY_DEFS) {
    const refs = cardRefs.get(def.id)!;
    refs.enabled.checked = state[def.keys.enabled] !== '0';
    refs.body.style.display = refs.enabled.checked ? '' : 'none';
    refs.longMs.value = state[def.keys.longMs];
    refs.repeat.checked = state[def.keys.repeat] === '1';
    actions[def.keys.single].set(state[def.keys.single]);
    actions[def.keys.double].set(state[def.keys.double]);
    actions[def.keys.long].set(state[def.keys.long]);
    refs.syncTimingRow();
  }
}

// ---------- 配置读写 ----------

async function configExists(): Promise<boolean> {
  uiLog('检查配置文件：' + CONFIG);
  try {
    await run(`test -f '${quote(CONFIG)}'`, 2500);
    uiLog('CONFIG FILE EXISTS');
    return true;
  } catch (e) {
    uiLog('CONFIG FILE NOT EXISTS: ' + String(e));
    return false;
  }
}

async function getConfigSize(): Promise<number> {
  const out = await run(`wc -c < '${quote(CONFIG)}'`, 2500);
  const size = Number(String(out).trim());
  if (!Number.isFinite(size)) throw new Error('无法解析配置文件大小：' + JSON.stringify(out));
  uiLog('CONFIG SIZE=' + size);
  return size;
}

async function readConfigFile(): Promise<string> {
  uiLog('读取配置文件原文：' + CONFIG);
  // 绕过 KSU WebUI 吞掉多行输出的 Bug：base64 压成单行，前端再解码
  const b64out = await run(`base64 '${quote(CONFIG)}' | tr -d '\\n\\r'`, 3000);
  let txt = '';
  try {
    txt = decodeURIComponent(escape(atob(b64out)));
  } catch (e) {
    uiLog('Base64 解码失败（可能是兜底的明文）：' + String(e));
    txt = b64out;
  }
  uiLog('CONFIG RAW=' + JSON.stringify(txt));
  return txt;
}

async function ensureConfigExists(): Promise<boolean> {
  if (await configExists()) {
    uiLog('配置文件存在，不创建、不覆盖');
    return false;
  }
  uiLog('配置文件不存在，创建默认配置');
  const text = makeDefaultConfig();
  const encoded = b64(text);
  const tmp = CONFIG + '.new';
  await run(
    `mkdir -p '${quote(CONFIG_DIR)}' && printf '%s' '${encoded}' | base64 -d > '${quote(tmp)}' && chmod 600 '${quote(tmp)}' && mv '${quote(tmp)}' '${quote(CONFIG)}'`,
    3000
  );
  uiLog('默认配置创建完成');
  return true;
}

async function load(): Promise<void> {
  uiLog('LOAD start');
  setStatus('正在读取配置…');
  const debugParts: string[] = [];
  try {
    await ensureApi();
    debugParts.push('=== LOAD START ===');
    debugParts.push('CONFIG=' + CONFIG);
    debugParts.push('API=' + getApiName());
    await ensureConfigExists();
    const exists = await configExists();
    debugParts.push('EXISTS=' + exists);
    if (!exists) throw new Error('配置文件不存在：' + CONFIG);
    const size = await getConfigSize();
    debugParts.push('SIZE=' + size);
    const txt = await readConfigFile();
    debugParts.push('=== RAW CONFIG ===');
    debugParts.push(txt || '<EMPTY>');
    if (!txt.trim()) throw new Error('配置文件存在，但是内容为空：' + CONFIG);
    const parsed = parse(txt);
    debugParts.push('=== PARSED ===');
    debugParts.push(JSON.stringify(parsed, null, 2));
    applyParsedConfig(parsed);
    debugParts.push('=== STATE ===');
    debugParts.push(JSON.stringify(state, null, 2));
    debugParts.push('=== LOAD SUCCESS ===');
    syncAllInputs();
    setStatus('配置已读取');
    await writeDebugFile(debugParts.join('\n'));
  } catch (e) {
    uiLog('LOAD ERROR ' + String(e));
    debugParts.push('=== LOAD ERROR ===');
    debugParts.push(String(e));
    try {
      const exists = await configExists();
      debugParts.push('ERROR RECOVERY EXISTS=' + exists);
      if (exists) {
        const size = await getConfigSize();
        debugParts.push('ERROR RECOVERY SIZE=' + size);
        const txt = await readConfigFile();
        debugParts.push('=== ERROR RECOVERY CONFIG BEGIN ===');
        debugParts.push(txt || '<EMPTY>');
        debugParts.push('=== ERROR RECOVERY CONFIG END ===');
      }
    } catch (readError) {
      debugParts.push('ERROR RECOVERY READ FAILED=' + String(readError));
    }
    setStatus('读取失败：' + String(e), false);
    try {
      await writeDebugFile(debugParts.join('\n'));
    } catch {
      /* ignore */
    }
  }
}

// ---------- 振动反馈 ----------

async function vibrate(duration = 25): Promise<void> {
  if (state.vibrate !== '1') return;
  uiLog('VIBRATE duration=' + duration);
  try {
    if (typeof navigator.vibrate === 'function') {
      const ok = navigator.vibrate(duration);
      uiLog('navigator.vibrate=' + ok);
      if (ok) return;
    }
  } catch (e) {
    uiLog('navigator.vibrate failed ' + String(e));
  }
  if (!hasExec()) return;
  const ms = Math.max(1, Math.min(1000, Number(duration) || 25));
  for (const cmd of [`/system/bin/cmd vibrator vibrate ${ms}`, `/system/bin/cmd vibrator_manager vibrate ${ms}`]) {
    try {
      await run(cmd, 1500);
      uiLog('shell vibrate OK: ' + cmd);
      return;
    } catch (e) {
      uiLog('shell vibrate failed: ' + cmd + ' => ' + String(e));
    }
  }
}

// ---------- 诊断 ----------

async function diagnostics(): Promise<void> {
  try {
    setStatus('正在收集诊断…');
    await ensureApi();
    const rawCmd =
      `echo '── 环境 ──'; date '+%F %T'; id; getenforce 2>&1; /data/adb/ksud -V 2>&1 | head -1; ` +
      `echo; echo '── daemon ──'; ` +
      `ps -A -o pid,etime,args 2>/dev/null | grep '[p]luskeyd' || echo 'pluskeyd 未运行'; ` +
      `echo; echo '── 配置 (${quote(CONFIG)}) ──'; cat '${quote(CONFIG)}' 2>&1; ` +
      `echo; echo '── 模块文件 ──'; ls -l '${quote(MODDIR)}/bin' '${quote(MODDIR)}/config' 2>&1; ` +
      `echo; echo '── daemon 日志（最近 40 行）──'; ` +
      `if [ -f '${quote(LOGFILE)}' ]; then tail -40 '${quote(LOGFILE)}'; else echo 'pluskey.log 不存在'; fi`;
    const cmd = `( ${rawCmd} ) | base64 | tr -d '\\n\\r'`;
    const b64out = await run(cmd, 6000);
    let out = '';
    try {
      out = decodeURIComponent(escape(atob(b64out)));
    } catch {
      out = b64out;
    }
    const log = $('log');
    log.hidden = false;
    log.textContent += (log.textContent ? '\n' : '') + '\n--- DEVICE DIAGNOSTICS ---\n' + out;
    await writeDebugFile('=== FULL DIAGNOSTICS ===\n' + out);
    setStatus('诊断完成');
  } catch (e) {
    uiLog('DIAG ERROR ' + String(e));
    setStatus('诊断失败：' + String(e), false);
  }
}

// ---------- 保存 ----------

async function save(): Promise<void> {
  try {
    setStatus('正在保存配置…');
    await ensureApi();
    const text = buildConfigText();
    state.vibrate = state.vibrate === '1' ? '1' : '0';
    syncAllInputs();
    uiLog('SAVE TEXT=' + JSON.stringify(text));
    const encoded = b64(text);
    const tmp = CONFIG + '.new';
    await run(
      `mkdir -p '${quote(CONFIG_DIR)}' && printf '%s' '${encoded}' | base64 -d > '${quote(tmp)}' && chmod 600 '${quote(tmp)}' && mv '${quote(tmp)}' '${quote(CONFIG)}'`,
      4000
    );
    uiLog('SAVE atomic replace finished');
    const exists = await configExists();
    if (!exists) throw new Error('保存后验证失败：配置文件不存在');
    const verifySize = await getConfigSize();
    const verifyText = await readConfigFile();
    uiLog('SAVE VERIFY=' + JSON.stringify({ exists, size: verifySize, text: verifyText }));
    await vibrate(35);
    setStatus('已保存，daemon 会自动应用');
    await writeDebugFile(
      'WebUI SAVE OK\n' +
        `exists=${exists}\n` +
        `size=${verifySize}\n` +
        '=== CONFIG CONTENT BEGIN ===\n' +
        verifyText +
        '=== CONFIG CONTENT END ===\n'
    );
  } catch (e) {
    uiLog('SAVE ERROR ' + String(e));
    setStatus('保存失败：' + String(e), false);
    try {
      await writeDebugFile('WebUI SAVE ERROR\n' + String(e));
    } catch {
      /* ignore */
    }
  }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
function debouncedSave(): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  setStatus('修改已记录，等待保存...');
  saveTimeout = setTimeout(() => {
    save();
  }, 350); // 用户停止操作 350ms 后自动执行保存
}

// ---------- 入口 ----------

$('reload').addEventListener('click', load);
$('diagnose').addEventListener('click', diagnostics);

monetInput.checked = localStorage.getItem('monet') !== '0';
applyMonet();

setStatus('正在读取配置…');
load();
