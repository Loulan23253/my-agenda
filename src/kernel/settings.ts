import type { Lang } from "../l10n/strings";

export interface CalendarConfig {
  id: string;
  url: string;
  name: string;
  category: string;
  enabled: boolean;
  /** Apple 日历颜色(discover 时抓取,#RRGGBB)。 */
  color?: string;
}

export interface LastSyncInfo {
  at: string;
  ok: boolean;
}

export interface Settings {
  lang: "auto" | "zh" | "en";
  folder: string;
  provider: "none" | "icloud" | "caldav" | "ics";
  user: string;
  password: string;
  calendars: CalendarConfig[];
  icsUrl: string;
  autoSyncMinutes: number;
  /** 冲突策略:ask = 手动同步时询问;server = 静默采用服务器版本。 */
  conflictPolicy: "ask" | "server";
  lastSync?: LastSyncInfo;
  accent: "ios" | "theme" | (string & {});
  weekStart: 0 | 1;
  remindersEnabled: boolean;
  injectEnabled: boolean;
  injectMarker: string;
  injectFolder: string;
  /** 新建日程的默认分类(空 = 无)。 */
  defaultCategory: string;
  /** 新建日程的默认提醒(分钟);-1 = 不提醒。 */
  defaultReminderMinutes: number;
  /** 调试日志。 */
  debugLogging: boolean;
  /** 注入格式:条目用勾选框。 */
  injectUseCheckbox: boolean;
  /** 注入格式:显示地点。 */
  injectShowPlace: boolean;
  /** 注入格式:显示分类。 */
  injectShowCategory: boolean;
  /** 注入格式:行前缀(嵌套引用 >> 或普通引用 >)。 */
  injectPrefix: string;
  /** 注入格式:时间制式。 */
  injectTimeFormat: "24h" | "12h";
  /** 分类自定义颜色(分类 → #rrggbb;未设走调色板)。 */
  categoryColors: Record<string, string>;
  /** 最近同步记录(最多 10 条)。 */
  syncHistory: { at: string; ok: boolean; msg?: string }[];
}

export const DEFAULTS: Settings = {
  lang: "auto",
  folder: "Agenda",
  provider: "none",
  user: "",
  password: "",
  calendars: [],
  icsUrl: "",
  autoSyncMinutes: 0,
  conflictPolicy: "ask",
  accent: "ios",
  weekStart: 1,
  remindersEnabled: true,
  injectEnabled: true,
  injectMarker: "> [!todo]+ todo",
  injectUseCheckbox: true,
  injectShowPlace: true,
  injectShowCategory: true,
  injectPrefix: ">>",
  injectTimeFormat: "24h",
  categoryColors: {},
  syncHistory: [],
  injectFolder: "",
  defaultCategory: "",
  defaultReminderMinutes: -1,
  debugLogging: false,
};

const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

function newCalendarId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function sanitizeColors(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) && k.trim()) out[k.trim()] = v;
    }
  }
  return out;
}

function sanitizeHistory(raw: unknown): { at: string; ok: boolean; msg?: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    return { at: str(r.at, ""), ok: bool(r.ok, false), msg: r.msg === undefined ? undefined : str(r.msg, "") };
  }).filter((x) => x.at);
}

function sanitizeCalendars(raw: unknown): CalendarConfig[] {
  if (!Array.isArray(raw)) return [];
  const byName = new Map<string, CalendarConfig>();
  const noName: CalendarConfig[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    const cfg: CalendarConfig = {
      id: str(c.id, newCalendarId()),
      url: str(c.url, "").trim(),
      name: str(c.name, ""),
      category: str(c.category, "").trim(),
      enabled: bool(c.enabled, true),
      color: str(c.color, "") || undefined,
    };
    if (!cfg.url) continue;
    // 去重:同名日历只保留最后一条。iCloud 中国区迁移会更换域名与日历 ID(URL 不同但同名),
    // 旧条目(如 .com → .com.cn)同步时会 403,必须淘汰
    if (cfg.name) {
      byName.set(cfg.name, cfg);
      continue;
    }
    noName.push(cfg);
  }
  return [...byName.values(), ...noName];
}

function sanitizeLegacyCalendars(r: Record<string, unknown>): CalendarConfig[] {
  if (Array.isArray(r.icloudCalendars)) {
    return sanitizeCalendars(
      (r.icloudCalendars as Record<string, unknown>[]).map((c) => ({ ...c, id: newCalendarId() })),
    );
  }
  const url = str(r.icloudCalUrl, "").trim();
  return url ? [{ id: newCalendarId(), url, name: "", category: "", enabled: true }] : [];
}

function sanitizeLastSync(raw: unknown): LastSyncInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const at = (raw as Record<string, unknown>)["at"];
  const ok = (raw as Record<string, unknown>)["ok"];
  if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || typeof ok !== "boolean") return undefined;
  return { at, ok };
}

export function sanitize(raw: unknown): Settings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const calendars = sanitizeCalendars(r.calendars);
  const migrated = calendars.length ? calendars : sanitizeLegacyCalendars(r);
  return {
    lang: r.lang === "zh" || r.lang === "en" ? r.lang : "auto",
    folder: str(r.folder, DEFAULTS.folder)
      .split("/")
      .filter((seg) => seg && seg !== "." && seg !== "..")
      .join("/"),
    provider: r.provider === "icloud" || r.provider === "caldav" || r.provider === "ics"
      ? r.provider
      : "none",
    user: str(r.user, ""),
    password: str(r.password, ""),
    calendars: migrated,
    icsUrl: str(r.icsUrl, ""),
    autoSyncMinutes: [0, 5, 15, 30, 60].includes(r.autoSyncMinutes as number) ? (r.autoSyncMinutes as number) : 0,
    conflictPolicy: r.conflictPolicy === "server" ? "server" : "ask",
    lastSync: sanitizeLastSync(r.lastSync),
    accent: str(r.accent, DEFAULTS.accent),
    weekStart: r.weekStart === 0 ? 0 : 1,
    remindersEnabled: bool(r.remindersEnabled, DEFAULTS.remindersEnabled),
    injectEnabled: bool(r.injectEnabled, DEFAULTS.injectEnabled),
    injectMarker: str(r.injectMarker, DEFAULTS.injectMarker),
    injectFolder: str(r.injectFolder, ""),
    defaultCategory: str(r.defaultCategory, ""),
    defaultReminderMinutes:
      typeof r.defaultReminderMinutes === "number" && r.defaultReminderMinutes >= -1
        ? Math.round(r.defaultReminderMinutes)
        : -1,
    debugLogging: bool(r.debugLogging, false),
    injectUseCheckbox: bool(r.injectUseCheckbox, true),
    injectShowPlace: bool(r.injectShowPlace, true),
    injectShowCategory: bool(r.injectShowCategory, true),
    injectPrefix: str(r.injectPrefix, ">>") === ">" ? ">" : ">>",
    injectTimeFormat: str(r.injectTimeFormat, "24h") === "12h" ? "12h" : "24h",
    categoryColors: sanitizeColors(r.categoryColors),
    syncHistory: sanitizeHistory(r.syncHistory),
  };
}

export function resolveLang(s: Settings, obsidianLocale: string | undefined): Lang {
  if (s.lang !== "auto") return s.lang;
  return obsidianLocale?.toLowerCase().startsWith("zh") ? "zh" : "en";
}
