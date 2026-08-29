#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define DEFAULT_MODDIR "/data/adb/modules/OPlusKey"
/* 配置文件必须放在模块目录之外：
 * Magisk / KernelSU 更新模块时会重建整个模块目录，放在里面会被刷掉 */
#define DEFAULT_DATADIR "/data/adb/OPlusKey"
#define INPUT_DIR "/dev/input"
#define UINPUT_DEVICE "/dev/uinput"
#define DEFAULT_LONG_PRESS_MS 500
#define DEFAULT_VIBRATION 0
#define MIN_LONG_PRESS_MS 100
#define MAX_LONG_PRESS_MS 10000
#define DEFAULT_DOUBLE_CLICK_MS 300
#define DEFAULT_REPEAT_INTERVAL_MS 300
#define MIN_DOUBLE_CLICK_MS 100
#define MAX_DOUBLE_CLICK_MS 2000
#define MIN_REPEAT_INTERVAL_MS 50
#define MAX_REPEAT_INTERVAL_MS 5000
/* longpress: 注入的按住时长。固定 3s：必须超过系统识别长按的阈值
 * （ColorOS 约 3s），不能用按键自身的 long_press_ms（那只是触发阈值） */
#define LONGPRESS_INJECT_HOLD_MS 3000
#define ACTION_MAX 512
#define LOG_MAX_MB 2
#define MAX_DEVICES 16
#define KEY_BYTES ((KEY_MAX + 7) / 8 + 1)

/* uinput 会被注册这些事件类型，用于原样转发被独占设备上的其他事件 */
static const int FORWARD_TYPES[] = { EV_SYN, EV_KEY, EV_MSC, EV_LED, EV_SND, EV_SW, EV_REP };
#define FORWARD_TYPE_COUNT (sizeof(FORWARD_TYPES) / sizeof(FORWARD_TYPES[0]))

#define test_bit(bit, array) (((const unsigned char *)(array))[(bit) / 8] & (1 << ((bit) % 8)))

static void uinput_destroy(void);
static int uinput_setup(void);
static void reset_child_signals(void);

enum key_id {
    KID_PLUS,
    KID_VOL_UP,
    KID_VOL_DOWN,
    KID_POWER,
    KID_COUNT
};

enum state {
    STATE_IDLE,
    STATE_PRESSED,
    STATE_WAIT_DOUBLE
};

enum cfg_field {
    F_SINGLE,
    F_DOUBLE,
    F_LONG,
    F_LONG_MS,
    F_LONG_REPEAT,
    F_ENABLED
};

struct key_config {
    char single[ACTION_MAX];
    char double_action[ACTION_MAX];
    char long_action[ACTION_MAX];
    int long_press_ms;
    int long_repeat;
    int enabled;
};

struct config_data {
    struct key_config keys[KID_COUNT];
    int double_click_ms;
    int repeat_interval_ms;
    int vibration;
    long long mtime_ns;
    off_t size;
};

struct key_ctx {
    int code;
    const char *name;
    struct key_config cfg;
    int native; /* single=native 且未配置双击/长按时整键原样透传，不参与状态机 */
    /* 运行时状态 */
    int state;
    long long press_start;
    long long first_release;
    int second_press;
    int long_triggered;
};

struct input_device {
    int fd;
    char name[128];
};

static volatile sig_atomic_t g_running = 1;
static volatile sig_atomic_t g_reload_requested = 0;
static int g_regrab_needed = 0; /* native 开关变化后需要重新扫描/独占设备 */
static int g_uinput_fd = -1;
static int g_lock_fd = -1;
static FILE *g_log = NULL;
static struct key_ctx g_keys[KID_COUNT] = {
    { .code = BTN_TRIGGER_HAPPY32, .name = "plus",
      .cfg = { .single = "native", .double_action = "none", .long_action = "none",
               .long_press_ms = 500, .long_repeat = 0, .enabled = 0 }, .native = 1 },
    { .code = KEY_VOLUMEUP, .name = "vol_up",
      .cfg = { .single = "native", .double_action = "none", .long_action = "none",
               .long_press_ms = 500, .long_repeat = 0, .enabled = 0 }, .native = 1 },
    { .code = KEY_VOLUMEDOWN, .name = "vol_down",
      .cfg = { .single = "native", .double_action = "none", .long_action = "none",
               .long_press_ms = 500, .long_repeat = 0, .enabled = 0 }, .native = 1 },
    { .code = KEY_POWER, .name = "power",
      .cfg = { .single = "native", .double_action = "none", .long_action = "none",
               .long_press_ms = 500, .long_repeat = 0, .enabled = 0 }, .native = 1 },
};
static int g_double_click_ms = DEFAULT_DOUBLE_CLICK_MS;
static int g_repeat_interval_ms = DEFAULT_REPEAT_INTERVAL_MS;
static int g_vibration = DEFAULT_VIBRATION;
static int g_moddir_fallback = 0; /* /proc/self/exe 推导失败，退回 DEFAULT_MODDIR */
static long long g_config_mtime_ns = 0;
static off_t g_config_size = 0;
static struct input_device g_devices[MAX_DEVICES];
static int g_device_count = 0;
static unsigned char g_key_bits[KEY_BYTES]; /* 所有被独占设备的 KEY 能力合集，用于 uinput */

static char g_moddir[PATH_MAX];
static char g_data_dir[PATH_MAX];
static char g_run_dir[PATH_MAX];
static char g_config_file[PATH_MAX];
static char g_legacy_config_file[PATH_MAX]; /* 旧版本的模块内配置，仅用于一次性迁移 */
static char g_log_file[PATH_MAX];
static char g_pid_file[PATH_MAX];
static char g_lock_file[PATH_MAX];
static pid_t g_longpress_child_pid = 0; /* 正在注入长按的子进程，防止并发交错 */

/*
 * 从 /proc/self/exe 推导模块目录（可执行文件位于 <moddir>/bin/pluskeyd），
 * 这样模块 ID 改名后无需重新编译。推导失败时退回 DEFAULT_MODDIR。
 */
static void resolve_paths(void)
{
    char exe[PATH_MAX];
    char *slash;
    ssize_t len;

    int derived = 0;
    snprintf(g_moddir, sizeof(g_moddir), "%s", DEFAULT_MODDIR);

    len = readlink("/proc/self/exe", exe, sizeof(exe) - 1);
    if (len > 0) {
        exe[len] = '\0';
        slash = strrchr(exe, '/');
        if (slash) {
            *slash = '\0';
            slash = strrchr(exe, '/');
            if (slash && strcmp(slash, "/bin") == 0) {
                *slash = '\0';
                if (exe[0] == '/') {
                    snprintf(g_moddir, sizeof(g_moddir), "%s", exe);
                    derived = 1;
                }
            }
        }
    }
    if (!derived) {
        g_moddir_fallback = 1;
    }

    snprintf(g_data_dir, sizeof(g_data_dir), "%s", DEFAULT_DATADIR);
    snprintf(g_run_dir, sizeof(g_run_dir), "%s/run", g_moddir);
    snprintf(g_config_file, sizeof(g_config_file), "%s/config.conf", g_data_dir);
    snprintf(g_legacy_config_file, sizeof(g_legacy_config_file), "%s/config/config.conf", g_moddir);
    snprintf(g_log_file, sizeof(g_log_file), "%s/pluskey.log", g_moddir);
    snprintf(g_pid_file, sizeof(g_pid_file), "%s/run/pluskeyd.pid", g_moddir);
    snprintf(g_lock_file, sizeof(g_lock_file), "%s/run/pluskeyd.lock", g_moddir);
}

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

/* 日志 fd 必须 CLOEXEC：fork 出的子进程（sh/am/input 等）不应继承日志文件的写句柄 */
static void set_cloexec(FILE *fp)
{
    if (fp) {
        fcntl(fileno(fp), F_SETFD, FD_CLOEXEC);
    }
}

static void log_open(void)
{
    g_log = fopen(g_log_file, "a");
    if (g_log) {
        setvbuf(g_log, NULL, _IOLBF, 0);
        set_cloexec(g_log);
    }
}

static void log_close(void)
{
    if (g_log) {
        fclose(g_log);
        g_log = NULL;
    }
}

static void log_msg(const char *fmt, ...)
{
    va_list ap;
    if (!g_log) {
        return;
    }

    {
        long pos = ftell(g_log);
        if (pos > (long)LOG_MAX_MB * 1024 * 1024) {
            freopen(g_log_file, "w", g_log);
            if (g_log) {
                setvbuf(g_log, NULL, _IOLBF, 0);
                set_cloexec(g_log);
                fprintf(g_log, "=== log rotated (limit %dMB) ===\n", LOG_MAX_MB);
            }
        }
    }

    va_start(ap, fmt);
    vfprintf(g_log, fmt, ap);
    va_end(ap);
    fflush(g_log);
}

static int is_action_none(const char *action)
{
    return !action || action[0] == '\0' || strcmp(action, "none") == 0;
}

/* 不会产生任何效果的动作：无操作 / native（native 作为双击/长按会被
 * validate_config 改成 none，这里兜底） */
static int action_is_noop(const char *action)
{
    return is_action_none(action) || strcmp(action, "native") == 0;
}

static void set_key_defaults(struct config_data *c)
{
    int i;
    memset(c, 0, sizeof(*c));
    c->double_click_ms = DEFAULT_DOUBLE_CLICK_MS;
    c->repeat_interval_ms = DEFAULT_REPEAT_INTERVAL_MS;
    c->vibration = DEFAULT_VIBRATION;
    for (i = 0; i < KID_COUNT; i++) {
        struct key_config *k = &c->keys[i];
        /* 默认全部保留原始行为：启用位为 0（等同 native），
         * 单击=native，长按阈值统一 500ms，持续触发关闭 */
        snprintf(k->single, ACTION_MAX, "native");
        snprintf(k->double_action, ACTION_MAX, "none");
        snprintf(k->long_action, ACTION_MAX, "none");
        k->long_press_ms = DEFAULT_LONG_PRESS_MS;
        k->long_repeat = 0;
        k->enabled = 0;
    }
}

static int create_default_config(void)
{
    FILE *fp;
    mkdir(g_data_dir, 0755);
    fp = fopen(g_config_file, "w");
    if (!fp) {
        log_msg("ERROR: cannot create config errno=%d (%s)\n", errno, strerror(errno));
        return -1;
    }
    fprintf(
        fp,
        "# OPlusKey Remapper\n"
        "# 动作格式: none=屏蔽 | native=保留原始按键 | passthrough=判定后转发一次按键\n"
        "#          keyevent:KEYCODE | shell:命令 | intent:ACTION | app:包名/Activity | 其他任意 shell 命令\n"
        "\n"
        "double_click_ms=300\n"
        "long_repeat_interval_ms=300\n"
        "vibrate=0\n"
        "\n"
        "# 侧键 (Plus Key)\n"
        "plus_enabled=0\n"
        "plus_long_press_ms=500\n"
        "plus_single=native\n"
        "plus_double=none\n"
        "plus_long=none\n"
        "plus_long_repeat=0\n"
        "\n"
        "# 电源键 (注意: 长按连发会屏蔽系统自带的电源长按菜单)\n"
        "power_enabled=0\n"
        "power_long_press_ms=500\n"
        "power_single=native\n"
        "power_double=none\n"
        "power_long=none\n"
        "power_long_repeat=0\n"
        "\n"
        "# 音量+\n"
        "vol_up_enabled=0\n"
        "vol_up_long_press_ms=500\n"
        "vol_up_single=native\n"
        "vol_up_double=none\n"
        "vol_up_long=none\n"
        "vol_up_long_repeat=0\n"
        "\n"
        "# 音量-\n"
        "vol_down_enabled=0\n"
        "vol_down_long_press_ms=500\n"
        "vol_down_single=native\n"
        "vol_down_double=none\n"
        "vol_down_long=none\n"
        "vol_down_long_repeat=0\n"
    );
    fflush(fp);
    fsync(fileno(fp));
    fclose(fp);
    chmod(g_config_file, 0600);
    log_msg("default config created\n");
    return 0;
}

static char *trim(char *s)
{
    char *end;
    while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') {
        s++;
    }
    end = s + strlen(s);
    while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r' || end[-1] == '\n')) {
        end--;
    }
    *end = '\0';
    return s;
}

static int parse_bool(const char *value)
{
    if (!value) {
        return 0;
    }
    if (strcasecmp(value, "on") == 0 || strcasecmp(value, "true") == 0 || strcasecmp(value, "yes") == 0 || strcmp(value, "1") == 0) {
        return 1;
    }
    return 0;
}

static int parse_int_in(const char *value, long min, long max)
{
    char *end = NULL;
    long v = strtol(value, &end, 10);
    if (end == value || *end != '\0' || v < min || v > max) {
        return -1;
    }
    return (int)v;
}

struct cfg_entry {
    const char *name;
    int key_id;
    enum cfg_field field;
};

static const struct cfg_entry CFG_ENTRIES[] = {
    /* 侧键同时接受旧配置键名（single/double/long/long_press_ms/long_repeat） */
    { "single", KID_PLUS, F_SINGLE },
    { "plus_single", KID_PLUS, F_SINGLE },
    { "double", KID_PLUS, F_DOUBLE },
    { "plus_double", KID_PLUS, F_DOUBLE },
    { "long", KID_PLUS, F_LONG },
    { "plus_long", KID_PLUS, F_LONG },
    { "long_press_ms", KID_PLUS, F_LONG_MS },
    { "plus_long_press_ms", KID_PLUS, F_LONG_MS },
    { "long_repeat", KID_PLUS, F_LONG_REPEAT },
    { "plus_long_repeat", KID_PLUS, F_LONG_REPEAT },
    { "power_single", KID_POWER, F_SINGLE },
    { "power_double", KID_POWER, F_DOUBLE },
    { "power_long", KID_POWER, F_LONG },
    { "power_long_press_ms", KID_POWER, F_LONG_MS },
    { "power_long_repeat", KID_POWER, F_LONG_REPEAT },
    { "vol_up_single", KID_VOL_UP, F_SINGLE },
    { "vol_up_double", KID_VOL_UP, F_DOUBLE },
    { "vol_up_long", KID_VOL_UP, F_LONG },
    { "vol_up_long_press_ms", KID_VOL_UP, F_LONG_MS },
    { "vol_up_long_repeat", KID_VOL_UP, F_LONG_REPEAT },
    { "vol_down_single", KID_VOL_DOWN, F_SINGLE },
    { "vol_down_double", KID_VOL_DOWN, F_DOUBLE },
    { "vol_down_long", KID_VOL_DOWN, F_LONG },
    { "vol_down_long_press_ms", KID_VOL_DOWN, F_LONG_MS },
    { "vol_down_long_repeat", KID_VOL_DOWN, F_LONG_REPEAT },
    { "plus_enabled", KID_PLUS, F_ENABLED },
    { "power_enabled", KID_POWER, F_ENABLED },
    { "vol_up_enabled", KID_VOL_UP, F_ENABLED },
    { "vol_down_enabled", KID_VOL_DOWN, F_ENABLED },
};

#define CFG_ENTRY_COUNT (sizeof(CFG_ENTRIES) / sizeof(CFG_ENTRIES[0]))

static int get_config_stat(long long *mtime_ns, off_t *size)
{
    struct stat st;
    if (stat(g_config_file, &st) != 0) {
        return -1;
    }
    if (mtime_ns) {
        *mtime_ns = ((long long)st.st_mtim.tv_sec) * 1000000000LL + (long long)st.st_mtim.tv_nsec;
    }
    if (size) {
        *size = st.st_size;
    }
    return 0;
}

static int parse_config_file(struct config_data *cfg)
{
    FILE *fp;
    char line[2048]; /* 行内容含 key + 512 的 value，留足余量避免长命令被 fgets 截断 */
    set_key_defaults(cfg);
    fp = fopen(g_config_file, "r");
    if (!fp) {
        log_msg("ERROR: fopen config failed errno=%d (%s)\n", errno, strerror(errno));
        return -1;
    }
    while (fgets(line, sizeof(line), fp)) {
        char *p;
        char *key;
        char *value;
        size_t i;
        p = trim(line);
        if (*p == '\0' || *p == '#') {
            continue;
        }
        key = p;
        value = strchr(p, '=');
        if (!value) {
            log_msg("CONFIG WARNING: invalid line: %s\n", p);
            continue;
        }
        *value = '\0';
        value++;
        key = trim(key);
        value = trim(value);
        if (*key == '\0') {
            continue;
        }
        if (strcmp(key, "double_click_ms") == 0) {
            int v = parse_int_in(value, MIN_DOUBLE_CLICK_MS, MAX_DOUBLE_CLICK_MS);
            if (v >= 0) {
                cfg->double_click_ms = v;
            } else {
                log_msg("CONFIG WARNING: invalid double_click_ms=%s, using %d\n", value, cfg->double_click_ms);
            }
            continue;
        }
        if (strcmp(key, "long_repeat_interval_ms") == 0) {
            int v = parse_int_in(value, MIN_REPEAT_INTERVAL_MS, MAX_REPEAT_INTERVAL_MS);
            if (v >= 0) {
                cfg->repeat_interval_ms = v;
            } else {
                log_msg("CONFIG WARNING: invalid long_repeat_interval_ms=%s, using %d\n", value, cfg->repeat_interval_ms);
            }
            continue;
        }
        if (strcmp(key, "vibration") == 0 || strcmp(key, "vibrate") == 0) {
            cfg->vibration = parse_bool(value);
            continue;
        }
        for (i = 0; i < CFG_ENTRY_COUNT; i++) {
            if (strcmp(key, CFG_ENTRIES[i].name) != 0) {
                continue;
            }
            {
                struct key_config *k = &cfg->keys[CFG_ENTRIES[i].key_id];
                switch (CFG_ENTRIES[i].field) {
                case F_SINGLE:
                    snprintf(k->single, ACTION_MAX, "%s", value);
                    break;
                case F_DOUBLE:
                    snprintf(k->double_action, ACTION_MAX, "%s", value);
                    break;
                case F_LONG:
                    snprintf(k->long_action, ACTION_MAX, "%s", value);
                    break;
                case F_LONG_MS: {
                    int v = parse_int_in(value, MIN_LONG_PRESS_MS, MAX_LONG_PRESS_MS);
                    if (v >= 0) {
                        k->long_press_ms = v;
                    } else {
                        log_msg("CONFIG WARNING: invalid %s=%s, using %d\n", key, value, k->long_press_ms);
                    }
                    break;
                }
                case F_LONG_REPEAT:
                    k->long_repeat = parse_bool(value);
                    break;
                case F_ENABLED:
                    k->enabled = parse_bool(value);
                    break;
                }
            }
            break;
        }
    }
    fclose(fp);
    if (get_config_stat(&cfg->mtime_ns, &cfg->size) != 0) {
        log_msg("ERROR: stat config failed errno=%d (%s)\n", errno, strerror(errno));
        return -1;
    }
    return 0;
}

/*
 * 配置合法性整理：
 * - long=native / double=native 没有意义（native 是整键实时透传），改为 none
 * - single=native 但又配置了双击或长按时，无法实时透传，退化为 passthrough
 * - 派生 native 标记：single=native 且双击/长按均为 none 时整键透传，完全不动该键所在设备
 */
static void validate_config(struct config_data *cfg)
{
    int i;
    for (i = 0; i < KID_COUNT; i++) {
        struct key_config *k = &cfg->keys[i];
        if (strcmp(k->long_action, "native") == 0) {
            log_msg("CONFIG WARNING: %s long=native is meaningless, using none\n", g_keys[i].name);
            snprintf(k->long_action, ACTION_MAX, "none");
        }
        if (strcmp(k->double_action, "native") == 0) {
            log_msg("CONFIG WARNING: %s double=native is meaningless, using none\n", g_keys[i].name);
            snprintf(k->double_action, ACTION_MAX, "none");
        }
        if (strcmp(k->single, "native") == 0 &&
            (!is_action_none(k->double_action) || !is_action_none(k->long_action))) {
            log_msg("CONFIG WARNING: %s single=native conflicts with double/long, using passthrough\n", g_keys[i].name);
            snprintf(k->single, ACTION_MAX, "passthrough");
        }
    }
}

static void apply_config(const struct config_data *cfg)
{
    int i;
    int native_changed = 0;
    for (i = 0; i < KID_COUNT; i++) {
        struct key_ctx *k = &g_keys[i];
        const struct key_config *c = &cfg->keys[i];
        int was_native = k->native;
        snprintf(k->cfg.single, ACTION_MAX, "%s", c->single);
        snprintf(k->cfg.double_action, ACTION_MAX, "%s", c->double_action);
        snprintf(k->cfg.long_action, ACTION_MAX, "%s", c->long_action);
        k->cfg.long_press_ms = c->long_press_ms;
        k->cfg.long_repeat = c->long_repeat;
        k->cfg.enabled = c->enabled;
        /* 禁用的按键等同 native：不独占、不处理 */
        k->native = !c->enabled ||
                    (strcmp(k->cfg.single, "native") == 0 &&
                     is_action_none(k->cfg.double_action) &&
                     is_action_none(k->cfg.long_action));
        if (was_native != k->native) {
            native_changed = 1;
        }
        log_msg("CONFIG %s: enabled=%d single=%s double=%s long=%s long_press_ms=%d long_repeat=%d native=%d\n",
                k->name, k->cfg.enabled, k->cfg.single, k->cfg.double_action, k->cfg.long_action,
                k->cfg.long_press_ms, k->cfg.long_repeat, k->native);
    }
    g_double_click_ms = cfg->double_click_ms;
    g_repeat_interval_ms = cfg->repeat_interval_ms;
    g_vibration = cfg->vibration;
    g_config_mtime_ns = cfg->mtime_ns;
    g_config_size = cfg->size;
    log_msg("CONFIG APPLIED: double_click_ms=%d long_repeat_interval_ms=%d vibrate=%s mtime_ns=%lld size=%lld\n",
            g_double_click_ms, g_repeat_interval_ms, g_vibration ? "on" : "off",
            g_config_mtime_ns, (long long)g_config_size);
    if (native_changed) {
        g_regrab_needed = 1;
        log_msg("NOTE: native mode changed, devices will be re-scanned\n");
    }
}

/* 小文件拷贝，成功返回 0 */
static int copy_file(const char *src, const char *dst)
{
    char buf[4096];
    FILE *in;
    FILE *out;
    size_t n;
    int ret = -1;

    in = fopen(src, "r");
    if (!in) {
        return -1;
    }
    out = fopen(dst, "w");
    if (!out) {
        fclose(in);
        return -1;
    }
    while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
        if (fwrite(buf, 1, n, out) != n) {
            goto out;
        }
    }
    if (ferror(in)) {
        goto out;
    }
    ret = 0;
out:
    if (fflush(out) != 0) {
        ret = -1;
    }
    fclose(in);
    fclose(out);
    if (ret == 0) {
        chmod(dst, 0600);
    }
    return ret;
}

/*
 * 旧版本把配置放在模块目录里，更新模块时会被清掉。
 * 新版首次启动时把那份配置搬到 /data/adb/OPlusKey 继续用，
 * 模块目录里的旧文件保留不动（万一要回滚），但不再读取。
 */
static void migrate_legacy_config(void)
{
    if (access(g_config_file, F_OK) == 0) {
        return;
    }
    if (access(g_legacy_config_file, F_OK) != 0) {
        return;
    }
    mkdir(g_data_dir, 0755);
    if (copy_file(g_legacy_config_file, g_config_file) == 0) {
        log_msg("CONFIG migrated from %s to %s\n", g_legacy_config_file, g_config_file);
    } else {
        log_msg("CONFIG migration failed errno=%d (%s)\n", errno, strerror(errno));
    }
}

static int load_config(void)
{
    struct config_data cfg;
    log_msg("CONFIG LOAD START\n");
    migrate_legacy_config();
    if (access(g_config_file, F_OK) != 0) {
        if (errno != ENOENT) {
            log_msg("CONFIG access failed errno=%d (%s)\n", errno, strerror(errno));
            return -1;
        }
        log_msg("CONFIG missing, creating default at %s\n", g_config_file);
        if (create_default_config() != 0) {
            return -1;
        }
    }
    if (parse_config_file(&cfg) != 0) {
        log_msg("CONFIG LOAD FAILED, old config kept\n");
        return -1;
    }
    validate_config(&cfg);
    apply_config(&cfg);
    log_msg("CONFIG LOAD SUCCESS\n");
    return 0;
}

static int config_changed(void)
{
    long long mtime_ns;
    off_t size;
    if (get_config_stat(&mtime_ns, &size) != 0) {
        return 0;
    }
    if (mtime_ns != g_config_mtime_ns || size != g_config_size) {
        return 1;
    }
    return 0;
}

static void reload_if_needed(void)
{
    if (!config_changed()) {
        return;
    }
    log_msg("\n==============================================\nCONFIG FILE CHANGED\n==============================================\n");
    if (load_config() == 0) {
        log_msg("CONFIG AUTO RELOAD SUCCESS\n");
    } else {
        log_msg("CONFIG AUTO RELOAD FAILED, old config kept\n");
    }
}

static void signal_handler(int sig)
{
    if (sig == SIGHUP) {
        g_reload_requested = 1;
        return;
    }
    if (sig == SIGTERM || sig == SIGINT) {
        g_running = 0;
        return;
    }
}

static int write_pid(void)
{
    FILE *fp;
    mkdir(g_run_dir, 0755);
    fp = fopen(g_pid_file, "w");
    if (!fp) {
        log_msg("ERROR: cannot write PID file errno=%d (%s)\n", errno, strerror(errno));
        return -1;
    }
    fprintf(fp, "%d\n", getpid());
    fflush(fp);
    fsync(fileno(fp));
    fclose(fp);
    chmod(g_pid_file, 0600);
    return 0;
}

static void remove_pid(void)
{
    unlink(g_pid_file);
}

static int acquire_lock(void)
{
    mkdir(g_run_dir, 0755);
    g_lock_fd = open(g_lock_file, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (g_lock_fd < 0) {
        log_msg("ERROR: open lock failed errno=%d (%s)\n", errno, strerror(errno));
        return -1;
    }
    if (flock(g_lock_fd, LOCK_EX | LOCK_NB) != 0) {
        if (errno == EWOULDBLOCK) {
            log_msg("ERROR: another pluskeyd already owns lock\n");
        } else {
            log_msg("ERROR: flock failed errno=%d (%s)\n", errno, strerror(errno));
        }
        close(g_lock_fd);
        g_lock_fd = -1;
        return -1;
    }
    if (ftruncate(g_lock_fd, 0) == 0) {
        char buf[64];
        int len = snprintf(buf, sizeof(buf), "%d\n", getpid());
        if (len > 0) {
            write(g_lock_fd, buf, (size_t)len);
        }
        fsync(g_lock_fd);
    }
    log_msg("INSTANCE LOCK ACQUIRED pid=%d\n", getpid());
    return 0;
}

/*
 * 扫描 /dev/input/event*，找出承载了需要处理的按键的设备。
 * 只包含 native 模式按键（整键透传）的设备完全不打开、不影响。
 * 打开设备的同时把它的 KEY 能力合并进 g_key_bits，供 uinput 转发使用。
 * 注意：此处只打开设备，不独占；独占在 uinput 就绪后统一执行，
 *       避免 uinput 建立失败时被独占设备的事件全部丢失。
 */
static void scan_devices(void)
{
    DIR *dir;
    struct dirent *de;
    int i;

    dir = opendir(INPUT_DIR);
    if (!dir) {
        log_msg("ERROR: opendir %s failed errno=%d (%s)\n", INPUT_DIR, errno, strerror(errno));
        return;
    }
    while ((de = readdir(dir)) != NULL && g_device_count < MAX_DEVICES) {
        char path[PATH_MAX];
        char name[128];
        unsigned char key_bits[KEY_BYTES];
        unsigned char ev_bits[8];
        int fd;
        int tracked = 0;
        int active = 0;
        ssize_t nlen;
        struct input_id id;

        if (strncmp(de->d_name, "event", 5) != 0) {
            continue;
        }
        snprintf(path, sizeof(path), "%s/%s", INPUT_DIR, de->d_name);
        /* 非阻塞：主循环排空读取时，缓冲区空了要立刻返回 EAGAIN，
         * 否则 read 会阻塞到下一个事件，饿死长按/双击定时器 */
        fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) {
            log_msg("scan: open %s failed errno=%d (%s)\n", path, errno, strerror(errno));
            continue;
        }
        memset(name, 0, sizeof(name));
        nlen = ioctl(fd, EVIOCGNAME(sizeof(name) - 1), name);
        (void)nlen;
        memset(&id, 0, sizeof(id));
        ioctl(fd, EVIOCGID, &id);
        /* 跳过自己创建的 uinput 设备 */
        if (strncmp(name, "OPlusKey", 8) == 0) {
            log_msg("scan: skip own uinput device %s (%s)\n", de->d_name, name);
            close(fd);
            continue;
        }
        memset(key_bits, 0, sizeof(key_bits));
        if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(key_bits)), key_bits) < 0) {
            log_msg("scan: EVIOCGBIT %s failed errno=%d (%s)\n", path, errno, strerror(errno));
            close(fd);
            continue;
        }
        for (i = 0; i < KID_COUNT; i++) {
            if (test_bit(g_keys[i].code, key_bits)) {
                tracked = 1;
                if (!g_keys[i].native) {
                    active = 1;
                }
            }
        }
        if (!tracked) {
            close(fd);
            continue;
        }
        /* 触摸/指针设备绝不独占：一加的触摸驱动可能声明 KEY_POWER（双击唤醒等手势），
         * 独占它会导致 EV_ABS 触摸数据被丢弃，屏幕失去触摸 */
        memset(ev_bits, 0, sizeof(ev_bits));
        if (ioctl(fd, EVIOCGBIT(0, sizeof(ev_bits)), ev_bits) >= 0 &&
            (test_bit(EV_ABS, ev_bits) || test_bit(EV_REL, ev_bits) || test_bit(EV_FF, ev_bits))) {
            log_msg("scan: %s (%s) is a touch/pointer device (EV_ABS/EV_REL/EV_FF), skipped even though it claims tracked keys (gesture emulation)\n",
                    de->d_name, name);
            close(fd);
            continue;
        }
        if (!active) {
            log_msg("scan: %s (%s) has only native-mode keys, left untouched\n", de->d_name, name);
            close(fd);
            continue;
        }
        for (i = 0; i < KID_COUNT; i++) {
            if (test_bit(g_keys[i].code, key_bits)) {
                log_msg("scan: %s (%s) bus=%04x provides %s%s\n", de->d_name, name,
                        id.bustype, g_keys[i].name, g_keys[i].native ? " (native passthrough)" : "");
            }
        }
        /* 合并 KEY 能力，让 uinput 能转发该设备上的所有按键 */
        {
            int code;
            for (code = 0; code <= KEY_MAX; code++) {
                if (test_bit(code, key_bits)) {
                    g_key_bits[code / 8] |= (unsigned char)(1 << (code % 8));
                }
            }
        }
        g_devices[g_device_count].fd = fd;
        snprintf(g_devices[g_device_count].name, sizeof(g_devices[g_device_count].name), "%s", name);
        g_device_count++;
    }
    closedir(dir);
    log_msg("scan: %d device(s) found\n", g_device_count);
}

/* 在 uinput 就绪后独占所有已选中的设备；失败的设备关闭并移出列表 */
static void grab_devices(void)
{
    int i = 0;
    while (i < g_device_count) {
        if (ioctl(g_devices[i].fd, EVIOCGRAB, 1) < 0) {
            log_msg("grab: EVIOCGRAB %s failed errno=%d (%s), excluded\n",
                    g_devices[i].name, errno, strerror(errno));
            close(g_devices[i].fd);
            g_devices[i] = g_devices[g_device_count - 1];
            g_device_count--;
            continue;
        }
        log_msg("grab: %s GRABBED\n", g_devices[i].name);
        i++;
    }
}

/*
 * 配置热重载导致 native 开关变化时调用：
 * 释放全部独占、重建 uinput（能力位图可能变化）、重新扫描并独占。
 * 期间不按键的话输入流无感知。
 */
static void reconfigure_devices(void)
{
    int i;
    log_msg("RECONFIGURE: releasing devices, recreating uinput, rescanning\n");
    for (i = 0; i < g_device_count; i++) {
        ioctl(g_devices[i].fd, EVIOCGRAB, 0);
        close(g_devices[i].fd);
    }
    g_device_count = 0;
    uinput_destroy();
    memset(g_key_bits, 0, sizeof(g_key_bits));
    scan_devices();
    if (g_device_count == 0) {
        log_msg("RECONFIGURE: no active device, idling until next config change\n");
        return;
    }
    if (uinput_setup() != 0) {
        log_msg("RECONFIGURE: uinput setup failed, releasing and idling\n");
        for (i = 0; i < g_device_count; i++) {
            close(g_devices[i].fd);
        }
        g_device_count = 0;
        return;
    }
    grab_devices();
    log_msg("RECONFIGURE: done, %d device(s) grabbed\n", g_device_count);
}

/* 销毁 uinput 虚拟设备（重复调用安全） */
static void uinput_destroy(void)
{
    if (g_uinput_fd >= 0) {
        ioctl(g_uinput_fd, UI_DEV_DESTROY);
        close(g_uinput_fd);
        g_uinput_fd = -1;
    }
}

static int uinput_setup(void)
{
    struct uinput_user_dev uidev;
    int i;

    uinput_destroy();
    g_uinput_fd = open(UINPUT_DEVICE, O_WRONLY | O_NONBLOCK | O_CLOEXEC);
    if (g_uinput_fd < 0) {
        log_msg("uinput open failed errno=%d (%s)\n", errno, strerror(errno));
        return -1;
    }
    for (i = 0; i < (int)FORWARD_TYPE_COUNT; i++) {
        if (ioctl(g_uinput_fd, UI_SET_EVBIT, FORWARD_TYPES[i]) < 0) {
            goto fail;
        }
    }
    /* 被独占设备上的所有按键 + 四个跟踪键（供 passthrough 注入） */
    for (i = 0; i <= KEY_MAX; i++) {
        if (test_bit(i, g_key_bits)) {
            ioctl(g_uinput_fd, UI_SET_KEYBIT, i);
        }
    }
    for (i = 0; i < KID_COUNT; i++) {
        ioctl(g_uinput_fd, UI_SET_KEYBIT, g_keys[i].code);
    }
    memset(&uidev, 0, sizeof(uidev));
    snprintf(uidev.name, sizeof(uidev.name), "OPlusKey Passthrough");
    uidev.id.bustype = BUS_VIRTUAL;
    uidev.id.vendor = 0x0001;
    uidev.id.product = 0x0001;
    uidev.id.version = 1;
    if (write(g_uinput_fd, &uidev, sizeof(uidev)) != sizeof(uidev)) {
        goto fail;
    }
    if (ioctl(g_uinput_fd, UI_DEV_CREATE) < 0) {
        goto fail;
    }
    usleep(100000);
    log_msg("uinput initialized\n");
    return 0;
fail:
    log_msg("uinput setup failed errno=%d (%s)\n", errno, strerror(errno));
    close(g_uinput_fd);
    g_uinput_fd = -1;
    return -1;
}

static void set_event_time(struct input_event *ev)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ev->input_event_sec = ts.tv_sec;
    ev->input_event_usec = ts.tv_nsec / 1000;
}

static void uinput_event(int type, int code, int value)
{
    struct input_event ev;
    if (g_uinput_fd < 0) {
        return;
    }
    memset(&ev, 0, sizeof(ev));
    set_event_time(&ev);
    ev.type = type;
    ev.code = code;
    ev.value = value;
    if (write(g_uinput_fd, &ev, sizeof(ev)) != sizeof(ev)) {
        log_msg("uinput write failed errno=%d (%s)\n", errno, strerror(errno));
    }
}

/* 原样转发事件（保留原始时间戳），用于未拦截的按键 */
static void forward_event(const struct input_event *ev)
{
    if (g_uinput_fd < 0) {
        return;
    }
    if (write(g_uinput_fd, ev, sizeof(*ev)) != sizeof(*ev)) {
        log_msg("uinput forward failed type=%d code=0x%x errno=%d (%s)\n",
                ev->type, ev->code, errno, strerror(errno));
    }
}

static void vibration_feedback(void)
{
    pid_t pid;
    if (!g_vibration) {
        return;
    }
    log_msg("VIBRATION feedback start\n");
    pid = fork();
    if (pid < 0) {
        log_msg("VIBRATION fork failed errno=%d (%s)\n", errno, strerror(errno));
        return;
    }
    if (pid == 0) {
        reset_child_signals();
        int nullfd = open("/dev/null", O_RDWR);
        if (nullfd >= 0) {
            dup2(nullfd, STDIN_FILENO);
            dup2(nullfd, STDOUT_FILENO);
            dup2(nullfd, STDERR_FILENO);
            if (nullfd > STDERR_FILENO) {
                close(nullfd);
            }
        }
        execl(
            "/system/bin/cmd",
            "cmd",
            "vibrator_manager",
            "synced",
            "-f",
            "oneshot",
            "30",
            (char *)NULL
        );
        _exit(127);
    }
}

/* 子进程 exec 前恢复默认信号处置：SIG_IGN 会跨 exec 传递，
 * 否则用户 shell 命令里的管道写将拿到 EPIPE 而不是 SIGPIPE */
static void reset_child_signals(void)
{
    signal(SIGPIPE, SIG_DFL);
}

static void reap_children(void)
{
    int status;
    for (;;) {
        pid_t pid = waitpid(-1, &status, WNOHANG);
        if (pid <= 0) {
            break;
        }
        if (pid == g_longpress_child_pid) {
            g_longpress_child_pid = 0;
        }
        if (WIFEXITED(status)) {
            log_msg("CHILD pid=%d exited status=%d\n", pid, WEXITSTATUS(status));
        } else if (WIFSIGNALED(status)) {
            log_msg("CHILD pid=%d killed signal=%d\n", pid, WTERMSIG(status));
        }
    }
}

/*
 * 通过 uinput 模拟真实的物理长按：down + 内核风格重复事件(value=2) + up。
 * ColorOS 等系统靠重复事件识别长按（input keyevent --longpress 没有重复事件，
 * 因此弹不出电源菜单），且系统阈值很长（约 3 秒）。
 * 注入在 fork 出的子进程里执行（子进程继承 uinput fd），不阻塞主循环。
 */
static void uinput_longpress(int code)
{
    pid_t pid;
    if (g_uinput_fd < 0) {
        log_msg("LONGPRESS inject unavailable: uinput disabled\n");
        return;
    }
    /* 僵尸态的 kill(pid, 0) 仍返回 0，先主动收割已退出的注入子进程再判断 */
    if (g_longpress_child_pid > 0) {
        int wr = waitpid(g_longpress_child_pid, NULL, WNOHANG);
        if (wr == g_longpress_child_pid || (wr < 0 && errno == ECHILD)) {
            g_longpress_child_pid = 0;
        }
    }
    /* 上一次注入仍在进行时跳过，避免多个子进程往同一 uinput 交错写不成对的 down/up */
    if (g_longpress_child_pid > 0 && kill(g_longpress_child_pid, 0) == 0) {
        log_msg("LONGPRESS inject skipped: previous injection (pid=%d) still running\n", g_longpress_child_pid);
        return;
    }
    pid = fork();
    if (pid < 0) {
        log_msg("LONGPRESS fork failed errno=%d (%s)\n", errno, strerror(errno));
        return;
    }
    if (pid > 0) {
        g_longpress_child_pid = pid;
        log_msg("LONGPRESS inject child pid=%d code=%d hold=%dms\n", pid, code, LONGPRESS_INJECT_HOLD_MS);
        return;
    }
    /* 子进程执行注入 */
    reset_child_signals();
    {
        int i;
        int repeats = LONGPRESS_INJECT_HOLD_MS / 100;
        struct input_event ev;
        if (repeats < 1) {
            repeats = 1;
        }
        memset(&ev, 0, sizeof(ev));
        set_event_time(&ev);
        ev.type = EV_KEY;
        ev.code = code;
        ev.value = 1;
        write(g_uinput_fd, &ev, sizeof(ev));
        ev.value = 0;
        ev.type = EV_SYN;
        ev.code = SYN_REPORT;
        write(g_uinput_fd, &ev, sizeof(ev));
        for (i = 0; i < repeats; i++) {
            usleep(100000);
            set_event_time(&ev);
            ev.type = EV_KEY;
            ev.code = code;
            ev.value = 2;
            write(g_uinput_fd, &ev, sizeof(ev));
            ev.value = 0;
            ev.type = EV_SYN;
            ev.code = SYN_REPORT;
            write(g_uinput_fd, &ev, sizeof(ev));
        }
        set_event_time(&ev);
        ev.type = EV_KEY;
        ev.code = code;
        ev.value = 0;
        write(g_uinput_fd, &ev, sizeof(ev));
        ev.value = 0;
        ev.type = EV_SYN;
        ev.code = SYN_REPORT;
        write(g_uinput_fd, &ev, sizeof(ev));
        _exit(0);
    }
}

static void execute_action(const char *action)
{
    pid_t pid;
    if (is_action_none(action) || strcmp(action, "native") == 0) {
        log_msg("ACTION: NONE\n");
        return;
    }
    if (strncmp(action, "longpress:", 10) == 0) {
        uinput_longpress(atoi(action + 10));
        return;
    }
    log_msg("ACTION EXEC: %s\n", action);
    pid = fork();
    if (pid < 0) {
        log_msg("ACTION fork failed errno=%d (%s)\n", errno, strerror(errno));
        return;
    }
    if (pid == 0) {
        setsid();
        reset_child_signals();
        int nullfd = open("/dev/null", O_RDWR);
        if (nullfd >= 0) {
            dup2(nullfd, STDIN_FILENO);
            dup2(nullfd, STDOUT_FILENO);
            dup2(nullfd, STDERR_FILENO);
            if (nullfd > STDERR_FILENO) {
                close(nullfd);
            }
        }
        if (strncmp(action, "keyevent:", 9) == 0) {
            const char *key = action + 9;
            execl("/system/bin/input", "input", "keyevent", key, (char *)NULL);
            _exit(127);
        }
        if (strncmp(action, "shell:", 6) == 0) {
            const char *cmd = action + 6;
            execl("/system/bin/sh", "sh", "-c", cmd, (char *)NULL);
            _exit(127);
        }
        if (strncmp(action, "intent:", 7) == 0) {
            const char *intent = action + 7;
            execl("/system/bin/am", "am", "start", "--user", "0", "-a", intent, (char *)NULL);
            _exit(127);
        }
        if (strncmp(action, "app:", 4) == 0) {
            const char *component = action + 4;
            execl("/system/bin/am", "am", "start", "--user", "0", "-n", component, (char *)NULL);
            _exit(127);
        }
        execl("/system/bin/sh", "sh", "-c", action, (char *)NULL);
        _exit(127);
    }
}

/* passthrough 动作对哪个键生效取决于配置在哪个键上 */
static void passthrough_for(struct key_ctx *k)
{
    if (g_uinput_fd < 0) {
        log_msg("PASSTHROUGH unavailable: uinput disabled\n");
        return;
    }
    log_msg("PASSTHROUGH %s\n", k->name);
    uinput_event(EV_KEY, k->code, 1);
    uinput_event(EV_SYN, SYN_REPORT, 0);
    usleep(30000);
    uinput_event(EV_KEY, k->code, 0);
    uinput_event(EV_SYN, SYN_REPORT, 0);
}

static void key_fire_long(struct key_ctx *k, int repeat)
{
    log_msg("ACTION: %s LONG%s action=%s\n", k->name, repeat ? " REPEAT" : "", k->cfg.long_action);
    if (strcmp(k->cfg.long_action, "passthrough") == 0) {
        passthrough_for(k);
        return;
    }
    /* 振动只用于真实动作的反馈：无操作/连发不震 */
    if (!repeat && !action_is_noop(k->cfg.long_action)) {
        vibration_feedback();
    }
    execute_action(k->cfg.long_action);
}

static void key_fire_single(struct key_ctx *k)
{
    log_msg("ACTION: %s SINGLE action=%s\n", k->name, k->cfg.single);
    if (strcmp(k->cfg.single, "passthrough") == 0) {
        passthrough_for(k);
        return;
    }
    if (!action_is_noop(k->cfg.single)) {
        vibration_feedback();
    }
    execute_action(k->cfg.single);
}

static void key_fire_double(struct key_ctx *k)
{
    log_msg("ACTION: %s DOUBLE action=%s\n", k->name, k->cfg.double_action);
    if (strcmp(k->cfg.double_action, "passthrough") == 0) {
        passthrough_for(k);
        return;
    }
    if (!action_is_noop(k->cfg.double_action)) {
        vibration_feedback();
    }
    execute_action(k->cfg.double_action);
}

static void key_down(struct key_ctx *k)
{
    if (k->state == STATE_IDLE) {
        k->press_start = now_ms();
        k->second_press = 0;
        k->long_triggered = 0;
        log_msg("%s DOWN, long timer %d ms\n", k->name, k->cfg.long_press_ms);
        k->state = STATE_PRESSED;
        return;
    }
    if (k->state == STATE_WAIT_DOUBLE) {
        k->second_press = 1;
        k->press_start = now_ms();
        k->long_triggered = 0;
        log_msg("%s SECOND DOWN\n", k->name);
        k->state = STATE_PRESSED;
        return;
    }
    /* PRESSED 状态下再次收到 down（异常），忽略 */
}

static void key_up(struct key_ctx *k)
{
    long long duration;
    if (k->state != STATE_PRESSED) {
        return;
    }
    duration = now_ms() - k->press_start;
    log_msg("%s UP duration=%lldms\n", k->name, duration);
    if (k->long_triggered) {
        log_msg("%s long already triggered, release only\n", k->name);
        k->state = STATE_IDLE;
        k->second_press = 0;
        k->long_triggered = 0;
        return;
    }
    if (duration >= k->cfg.long_press_ms) {
        key_fire_long(k, 0);
        k->state = STATE_IDLE;
        k->second_press = 0;
        k->long_triggered = 0;
        return;
    }
    if (k->second_press) {
        key_fire_double(k);
        k->state = STATE_IDLE;
        k->second_press = 0;
        k->long_triggered = 0;
        return;
    }
    if (is_action_none(k->cfg.double_action)) {
        /* 未配置双击：单击立即触发，不等待双击窗口 */
        key_fire_single(k);
        k->state = STATE_IDLE;
        k->second_press = 0;
        k->long_triggered = 0;
        return;
    }
    k->first_release = now_ms();
    k->state = STATE_WAIT_DOUBLE;
    log_msg("%s waiting for double click %d ms\n", k->name, g_double_click_ms);
}

/* 返回该键下一次超时的剩余毫秒数，-1 表示无定时器 */
static long long key_timeout_ms(struct key_ctx *k)
{
    if (k->state == STATE_PRESSED) {
        if (!k->long_triggered) {
            long long remain = (long long)k->cfg.long_press_ms - (now_ms() - k->press_start);
            return remain > 0 ? remain : 0;
        }
        if (k->cfg.long_repeat && !is_action_none(k->cfg.long_action) &&
            strncmp(k->cfg.long_action, "longpress:", 10) != 0) {
            long long remain = (long long)g_repeat_interval_ms - (now_ms() - k->press_start);
            return remain > 0 ? remain : 0;
        }
        return -1;
    }
    if (k->state == STATE_WAIT_DOUBLE) {
        long long remain = (long long)g_double_click_ms - (now_ms() - k->first_release);
        return remain > 0 ? remain : 0;
    }
    return -1;
}

static void key_timeout(struct key_ctx *k)
{
    if (k->state == STATE_PRESSED && !k->long_triggered) {
        log_msg("%s LONG PRESS TRIGGERED (>= %d ms)\n", k->name, k->cfg.long_press_ms);
        k->long_triggered = 1;
        key_fire_long(k, 0);
        return;
    }
    if (k->state == STATE_PRESSED && k->long_triggered) {
        /* 长按连发 */
        key_fire_long(k, 1);
        k->press_start = now_ms();
        return;
    }
    if (k->state == STATE_WAIT_DOUBLE) {
        log_msg("%s double click timeout\n", k->name);
        key_fire_single(k);
        k->state = STATE_IDLE;
        k->second_press = 0;
        k->long_triggered = 0;
        return;
    }
}

static struct key_ctx *find_key(int code)
{
    int i;
    for (i = 0; i < KID_COUNT; i++) {
        if (g_keys[i].code == code) {
            return &g_keys[i];
        }
    }
    return NULL;
}

static void dispatch_event(struct input_device *dev, const struct input_event *ev)
{
    struct key_ctx *k;
    size_t i;
    (void)dev;

    if (ev->type == EV_KEY) {
        k = find_key(ev->code);
        if (k) {
            if (k->native) {
                /* 整键透传：原样转发，保留连发与原始时序 */
                forward_event(ev);
                return;
            }
            if (ev->value == 1) {
                key_down(k);
            } else if (ev->value == 0) {
                key_up(k);
            }
            /* value==2 为内核自动连发，被拦截键不需要 */
            return;
        }
        forward_event(ev);
        return;
    }
    for (i = 0; i < FORWARD_TYPE_COUNT; i++) {
        if (ev->type == FORWARD_TYPES[i]) {
            forward_event(ev);
            return;
        }
    }
    log_msg("DROPPED event type=%d code=0x%x (not forwardable)\n", ev->type, ev->code);
}

static void process_reload(void)
{
    if (!g_reload_requested) {
        return;
    }
    g_reload_requested = 0;
    log_msg("\n==============================================\nSIGHUP RELOAD REQUESTED\n==============================================\n");
    if (load_config() == 0) {
        log_msg("SIGHUP RELOAD SUCCESS\n");
    } else {
        log_msg("SIGHUP RELOAD FAILED, old config kept\n");
    }
}

int main(void)
{
    int i;
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);
    signal(SIGHUP, signal_handler);
    signal(SIGPIPE, SIG_IGN);
    resolve_paths();
    log_open();
    log_msg("\n==============================================\npluskeyd starting\nPID=%d\nmoddir=%s\n==============================================\n", getpid(), g_moddir);
    log_msg("config=%s\n", g_config_file);
    if (g_moddir_fallback) {
        log_msg("WARNING: moddir derive from /proc/self/exe failed, using default %s\n", DEFAULT_MODDIR);
    }
    if (acquire_lock() != 0) {
        log_msg("pluskeyd: duplicate instance refused\n");
        log_close();
        return 1;
    }
    write_pid();
    if (load_config() != 0) {
        log_msg("WARNING: initial config load failed, defaults kept\n");
    }
    g_regrab_needed = 0; /* 初始加载由下面的 scan_devices 完成 */
    scan_devices();
    if (g_device_count == 0) {
        /* 全部按键禁用时保持待命：低频轮询配置，WebUI 里重新启用后热恢复 */
        log_msg("WARNING: no active key devices, idling until config enables one\n");
    }
    if (g_device_count > 0) {
        if (uinput_setup() != 0) {
            /* 没有转发通道就独占设备 = 被独占设备按键全废，宁可退出 */
            log_msg("ERROR: uinput unavailable, refusing to grab devices, exiting\n");
            for (i = 0; i < g_device_count; i++) {
                close(g_devices[i].fd);
            }
            g_device_count = 0;
            remove_pid();
            if (g_lock_fd >= 0) {
                close(g_lock_fd);
                g_lock_fd = -1;
            }
            log_close();
            return 1;
        }
        grab_devices();
    }
    log_msg("waiting for events...\n");
    while (g_running) {
        fd_set rfds;
        struct timeval tv;
        struct timeval *tv_ptr = NULL;
        int maxfd = -1;
        long long timeout_ms = -1;
        int ret;

        reap_children();
        process_reload();
        reload_if_needed();
        if (g_regrab_needed) {
            g_regrab_needed = 0;
            reconfigure_devices();
        }

        for (i = 0; i < KID_COUNT; i++) {
            long long t = key_timeout_ms(&g_keys[i]);
            if (t >= 0 && (timeout_ms < 0 || t < timeout_ms)) {
                timeout_ms = t;
            }
        }
        if (timeout_ms >= 0) {
            tv.tv_sec = timeout_ms / 1000;
            tv.tv_usec = (timeout_ms % 1000) * 1000;
            tv_ptr = &tv;
        }
        /* 无按键事件时 select 会一直阻塞，配置热重载将无法被察觉；
         * 轮询上限 500ms，保证开关切换在半秒内生效 */
        if (tv_ptr == NULL || timeout_ms > 500) {
            tv.tv_sec = 0;
            tv.tv_usec = 500000;
            tv_ptr = &tv;
        }

        FD_ZERO(&rfds);
        for (i = 0; i < g_device_count; i++) {
            FD_SET(g_devices[i].fd, &rfds);
            if (g_devices[i].fd > maxfd) {
                maxfd = g_devices[i].fd;
            }
        }
        ret = select(maxfd + 1, &rfds, NULL, NULL, tv_ptr);
        if (ret < 0) {
            if (errno == EINTR) {
                continue;
            }
            log_msg("select failed errno=%d (%s)\n", errno, strerror(errno));
            break;
        }
        if (ret == 0) {
            /* 轮询 tick 或定时器到期：只处理真正到期的键，
             * 否则 500ms 轮询会在阈值/间隔未到时误触发长按与连发 */
            for (i = 0; i < KID_COUNT; i++) {
                if (key_timeout_ms(&g_keys[i]) == 0) {
                    key_timeout(&g_keys[i]);
                }
            }
            continue;
        }
        for (i = 0; i < g_device_count; i++) {
            struct input_device *dev = &g_devices[i];
            if (!FD_ISSET(dev->fd, &rfds)) {
                continue;
            }
            for (;;) {
                struct input_event ev;
                ssize_t n = read(dev->fd, &ev, sizeof(ev));
                if (n < 0) {
                    if (errno == EINTR) {
                        continue;
                    }
                    if (errno != EAGAIN && errno != EWOULDBLOCK) {
                        log_msg("read %s failed errno=%d (%s), shutting down\n", dev->name, errno, strerror(errno));
                        g_running = 0;
                    }
                    break;
                }
                if (n != sizeof(ev)) {
                    break;
                }
                dispatch_event(dev, &ev);
            }
        }
    }
    log_msg("pluskeyd shutting down pid=%d\n", getpid());
    reap_children();
    for (i = 0; i < g_device_count; i++) {
        ioctl(g_devices[i].fd, EVIOCGRAB, 0);
        close(g_devices[i].fd);
    }
    g_device_count = 0;
    uinput_destroy();
    remove_pid();
    if (g_lock_fd >= 0) {
        close(g_lock_fd);
        g_lock_fd = -1;
    }
    log_msg("pluskeyd stopped\n");
    log_close();
    return 0;
}
