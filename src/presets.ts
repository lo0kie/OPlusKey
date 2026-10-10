// 动作预设表：值 → daemon 侧按前缀解析（keyevent: / shell: / intent: / app: / longpress:）
// 值的语法与解析见 README「动作写法」与 src/pluskeyd.c 的 execute_action

/* [值, Material Symbols 图标名, 显示文本] */
export type Preset = [value: string, icon: string, label: string];

/*
 * 手电筒：交给 daemon 的 flashlight: 动作处理。
 * SystemUI 的 ACTION_SWITCH_FLASHLIGHT 是「设为指定状态」而非 toggle
 * （真机实测 false→亮、true→灭，重复发同一值状态不变），
 * 切换必须先读 /sys/class/leds 的亮度判断当前状态，这一判断放在 daemon 里做，
 * 避免每次按键 fork 一个 shell 去 glob + cat。
 */
const FLASHLIGHT = 'flashlight:';

export const ACTION_PRESETS: Preset[] = [
  ['none', 'block', '无操作'],
  ['native', 'settings_backup_restore', '保留原始按键'],
  [FLASHLIGHT, 'flashlight_on', '手电筒'],
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

// 双击/长按没有「保留原始按键」：键被接管后不存在原生行为，去掉避免误导
export const ACTION_PRESETS_NO_NATIVE: Preset[] = ACTION_PRESETS.filter(([v]) => v !== 'native');
