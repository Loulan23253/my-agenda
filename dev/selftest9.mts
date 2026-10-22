// 第九轮自检:重置全部同步数据 / 清空日历本地日程 / 停用日历重新启用后事件收养 /
//             status 落盘往返 / notes 转义(escapeText/unescapeText)对称性
// 运行:npx tsx dev/selftest9.mts
// 说明:
//   §1/§2 用 esbuild 把 src/main.ts 打成 CJS bundle,再 new Function 注入自建 obsidian 桩
//        实例化真实插件类(onload 后直接调 resetAllSyncData / clearCalendarLocalEvents);
//        bundle 入口同时 re-export EMPTY_JOURNAL/journalPut,专测"重置不共享 EMPTY_JOURNAL 常量"。
//   §3 引擎直测:engine.ts→dav.ts 顶层 import "obsidian"(仅 requestUrl),沿用 selftest8 的
//        Module._resolveFilename 钩子指向本地桩;补"停用期间改动保留 → 重新启用后推送/收养"场景。
//   §4/§5 纯 note-format 往返(escapeText/unescapeText 为模块私有,经 serializeBlock→parseMonthlyNote
//        →blockToEvent 公共路径覆盖)。
import Module from "node:module";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";

const req = createRequire(import.meta.url);
const { JSDOM } = req("jsdom");
(globalThis as { DOMParser?: unknown }).DOMParser = new JSDOM().window.DOMParser;
(globalThis as { crypto?: unknown }).crypto ??= (await import("node:crypto")).webcrypto;
// main.ts 经 window.setInterval 注册提醒定时器:给"返回 0 且不排程"的最小桩,避免进程挂住
(globalThis as { window?: unknown }).window = {
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
};

// ── engine.ts(§3)顶层 import "obsidian":挂钩子指向本地 CJS 桩(同 selftest8)──
const stubPath = req.resolve("./obsidian-cjs-stub.cjs");
const origResolve = (Module as unknown as {
  _resolveFilename: (this: unknown, request: string, parent: unknown, ...rest: unknown[]) => string;
})._resolveFilename;
(Module as unknown as { _resolveFilename: unknown })._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "obsidian") return stubPath;
  return origResolve.call(this, request, ...rest);
} as never;

const { SyncEngine } = await import("../src/sync/engine.ts");
const { parseIcsToEvents } = await import("../src/sync/ical.ts");
import { t } from "../src/l10n/strings.ts";
import { serializeBlock, parseMonthlyNote, blockToEvent } from "../src/data/note-format.ts";
import { contentFingerprint } from "../src/model/content-fingerprint.ts";
import { MonthlyNoteStore } from "../src/data/note-store.ts";
import type { Settings } from "../src/kernel/settings.ts";
import type { SyncJournal, JournalEntry } from "../src/data/journal.ts";
import type { CalendarEvent } from "../src/model/event.ts";
import type { CalendarRoute } from "../src/sync/engine.ts";
import type { KeyValueFileIO } from "../src/data/io.ts";
import type { Http } from "../src/sync/dav.ts";

let pass = 0;
const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else fails.push(`${name}: got ${g}, want ${w}`);
};
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ": " + detail : ""}`);
};

// ════════════════════════ 插件实例化基建(esbuild bundle + obsidian 桩)════════════════════════

const PROJECT = path.resolve(import.meta.dirname, "..");
const BUNDLE_ENTRY = path.join(os.tmpdir(), "myagenda-selftest9-entry.ts");
const BUNDLE_OUT = path.join(os.tmpdir(), "myagenda-selftest9-bundle.cjs");
fs.writeFileSync(
  BUNDLE_ENTRY,
  `export { default } from ${JSON.stringify(path.join(PROJECT, "src/main.ts"))};\n` +
  `export { EMPTY_JOURNAL, journalPut } from ${JSON.stringify(path.join(PROJECT, "src/data/journal.ts"))};\n`,
);
await esbuild.build({
  entryPoints: [BUNDLE_ENTRY],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2020",
  external: ["obsidian"],
  outfile: BUNDLE_OUT,
  sourcemap: false,
  logLevel: "silent",
});

interface PluginExt {
  settings: Settings;
  journal: SyncJournal;
  commands: { id: string }[];
  data: unknown;
  savedData: Record<string, unknown> | undefined;
  onload(): Promise<void>;
  resetAllSyncData(): Promise<void>;
  clearCalendarLocalEvents(cal: { id: string; name: string }): Promise<void>;
}
type PluginCtor = new (app: unknown, manifest: unknown) => PluginExt;
interface BundleExports {
  default: PluginCtor;
  EMPTY_JOURNAL: SyncJournal;
  journalPut: (j: SyncJournal, id: string, e: JournalEntry) => void;
}

const MANIFEST = { id: "myagenda-v2", name: "MyAgenda", version: "0.0.0-selftest9" };

/** 自建 obsidian 桩模块:Plugin/Notice(收集)/文件类等,够 onload 真实跑通。 */
const makeStubModule = () => {
  const notices: string[] = [];
  class Notice {
    constructor(msg?: unknown) { notices.push(typeof msg === "string" ? msg : String(msg ?? "")); }
    hide(): void {}
  }
  class Component {}
  class TAbstractFile { path = ""; name = ""; }
  class TFile extends TAbstractFile { extension = ""; stat = { ctime: 0, mtime: 0, size: 0 }; }
  class TFolder extends TAbstractFile { children: unknown[] = []; }
  class WorkspaceLeaf {}
  class ItemView { constructor(_leaf?: unknown) {} }
  class Modal {
    modalEl = { addClass() {} };
    contentEl = { createDiv() { return { createEl() { return { addEventListener() {} }; } }; } };
    onClose = () => {};
    constructor(_app?: unknown) {}
    open() { this.onClose(); } // 模拟关闭选择窗口，不点击选项。
    close() {}
  }
  class PluginSettingTab { constructor(_app?: unknown, _plugin?: unknown) {} }
  class Plugin {
    app: unknown; manifest: unknown; data: unknown; savedData: unknown;
    commands: { id: string }[] = [];
    constructor(app: unknown, manifest: unknown) { this.app = app; this.manifest = manifest; }
    async loadData(): Promise<unknown> { return this.data ?? null; }
    async saveData(d: unknown): Promise<void> { this.savedData = d; }
    addCommand(c: { id: string }): { id: string } { this.commands.push(c); return c; }
    addRibbonIcon(): void {} addSettingTab(): void {} registerView(): void {}
    registerEvent(): void {} register(): void {} registerInterval(): void {}
    registerEditorExtension(): void {} registerMarkdownPostProcessor(): void {}
  }
  class Setting {
    setName(): this { return this; } setDesc(): this { return this; } setHeading(): this { return this; }
    addText(): this { return this; } addToggle(): this { return this; } addDropdown(): this { return this; }
    addButton(): this { return this; } addExtraButton(): this { return this; } addSlider(): this { return this; }
    setClass(): this { return this; }
  }
  class App {} class Vault {} class FileManager {}
  const requestUrl = async () => ({ status: 0, text: "", headers: {} });
  const normalizePath = (p: string): string => p;
  const setIcon = (): void => {};
  const addIcon = (): void => {};
  const moment = (x: unknown): unknown => x;
  return {
    notices,
    exports: {
      Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, TAbstractFile, WorkspaceLeaf,
      ItemView, Modal, Component, App, Vault, FileManager, requestUrl, normalizePath, setIcon, addIcon, moment,
    } as Record<string, unknown>,
  };
};

const loadBundle = (stubExports: Record<string, unknown>): BundleExports => {
  const code = fs.readFileSync(BUNDLE_OUT, "utf8");
  const mod = { exports: {} as Record<string, unknown> };
  const reqShim = (id: string): unknown => (id === "obsidian" ? stubExports : req(id));
  new Function("require", "module", "exports", code)(reqShim, mod, mod.exports);
  return mod.exports as unknown as BundleExports;
};

interface PluginHandle {
  plugin: PluginExt & { savedData?: Record<string, unknown> };
  bundle: BundleExports;
  files: Map<string, string>;
  notices: string[];
}

/** 内存 vault(路径→内容)+ 真实插件 onload;seed 预置文件,data 预置 data.json。 */
const makePlugin = async (opts: { data?: Record<string, unknown>; seed?: Record<string, string> } = {}): Promise<PluginHandle> => {
  const stub = makeStubModule();
  const bundle = loadBundle(stub.exports);
  const files = new Map<string, string>();
  for (const [p, c] of Object.entries(opts.seed ?? {})) files.set(p, c);
  const TFileC = stub.exports.TFile as new () => { path: string; name: string; extension: string };
  const TFolderC = stub.exports.TFolder as new () => { path: string; children: unknown[] };
  const mkFile = (p: string) => {
    const f = new TFileC();
    f.path = p;
    f.name = p.slice(p.lastIndexOf("/") + 1);
    f.extension = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".") + 1) : "";
    return f;
  };
  const parentOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  const vault = {
    on: () => ({}),
    getAbstractFileByPath: (p: string): unknown => {
      if (files.has(p)) return mkFile(p);
      if ([...files.keys()].some((k) => k.startsWith(p + "/"))) {
        const fo = new TFolderC();
        fo.path = p;
        fo.children = [...files.keys()].filter((k) => parentOf(k) === p).map(mkFile);
        return fo;
      }
      return null;
    },
    read: async (f: { path: string }) => files.get(f.path) ?? "",
    process: async (f: { path: string }, fn: (c: string) => string) => { files.set(f.path, fn(files.get(f.path) ?? "")); },
    create: async (p: string, c: string) => { files.set(p, c); return mkFile(p); },
    createFolder: async () => {},
    cachedRead: async (f: { path: string }) => files.get(f.path) ?? "",
    getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map(mkFile),
    adapter: {
      exists: async (p: string) => files.has(p),
      read: async (p: string) => {
        const c = files.get(p);
        if (c === undefined) throw new Error("missing: " + p);
        return c;
      },
      write: async (p: string, c: string) => { files.set(p, c); },
      remove: async (p: string) => { files.delete(p); },
    },
  };
  const app = {
    vault,
    fileManager: { trashFile: async (f: { path: string }) => { files.delete(f.path); } },
    workspace: {
      getLeavesOfType: () => [] as unknown[],
      getLeaf: () => ({}),
      revealLeaf: async () => {},
      onLayoutReady: () => {},
    },
  };
  const plugin = new bundle.default(app, MANIFEST) as PluginHandle["plugin"];
  plugin.data = opts.data ?? {};
  await plugin.onload();
  return { plugin, bundle, files, notices: stub.notices };
};

const baseData = (): Record<string, unknown> => ({
  folder: "Agenda",
  lang: "zh",
  provider: "icloud",
  user: "user@icloud.com",
  password: "app-pass-1234",
  calendars: [
    { id: "cal-a", url: "https://caldav.example.com/a/", name: "个人", category: "个人", enabled: true },
    { id: "cal-b", url: "https://caldav.example.com/b/", name: "工作", category: "工作", enabled: true },
  ],
  lastSync: { at: "2026-10-01T08:00:00.000Z", ok: true },
});

// ════════════════════════ §0/§1 重置全部同步数据(resetAllSyncData)════════════════════════
{
  const seed09 = [
    "## 10:00–11:00 教练课",
    "- id:: e-a@myagenda",
    "- starts:: 2026-09-29T10:00:00",
    "- ends:: 2026-09-29T11:00:00",
    "- allday:: false",
    "",
    "## 14:00–15:00 例会",
    "- id:: e-c@myagenda",
    "- starts:: 2026-09-29T14:00:00",
    "- ends:: 2026-09-29T15:00:00",
    "- allday:: false",
    "",
    "## 手写随记(非日程块)",
    "这一段没有任何字段,重置后必须保留。",
  ].join("\n");
  const seed10 = [
    "## 假期",
    "- id:: e-b@myagenda",
    "- starts:: 2026-10-05",
    "- ends:: 2026-10-06",
    "- allday:: true",
  ].join("\n");
  const seedJournal = JSON.stringify({
    version: 2,
    calendars: { "cal-a": { url: "https://caldav.example.com/a/", syncToken: "tok-1" } },
    events: {
      "e-a@myagenda": { calendarId: "cal-a", href: "https://caldav.example.com/a/e-a.ics", etag: '"1"', pushedFingerprint: "fp-a", state: "synced" },
      "e-b@myagenda": { calendarId: "cal-a", href: "https://caldav.example.com/a/e-b.ics", etag: '"2"', pushedFingerprint: "fp-b", state: "synced" },
      "e-c@myagenda": { calendarId: "cal-b", href: "https://caldav.example.com/b/e-c.ics", etag: '"3"', pushedFingerprint: "fp-c", state: "synced" },
      "e-pd@myagenda": { calendarId: "cal-b", state: "pendingDelete" },
    },
  });

  const h = await makePlugin({
    data: baseData(),
    seed: { "Agenda/2026-09.md": seed09, "Agenda/2026-10.md": seed10, "Agenda/.myagenda/journal.json": seedJournal },
  });
  const { plugin, files, notices } = h;

  // 桩自检:onload 真实跑通、账本从盘加载
  eq("实例:onload 命令 id 不重复", new Set(plugin.commands.map((c) => c.id)).size, plugin.commands.length);
  ok(
    "实例:含 reset/clearLocal 命令",
    plugin.commands.some((c) => c.id === "reset-sync-data") && plugin.commands.some((c) => c.id === "clear-calendar-local"),
  );
  eq("实例:账本从盘加载 4 条", Object.keys(plugin.journal.events).length, 4);

  const mark = notices.length;
  await plugin.resetAllSyncData();
  const msg1 = notices.slice(mark);

  // 笔记事件块全删(手写块保留)
  const after09 = files.get("Agenda/2026-09.md") ?? "";
  const after10 = files.get("Agenda/2026-10.md") ?? "";
  ok("重置:手写标题保留", after09.includes("手写随记(非日程块)"));
  ok("重置:手写正文保留", after09.includes("这一段没有任何字段,重置后必须保留。"));
  ok("重置:事件块 e-a 移除", !after09.includes("e-a@myagenda") && !after09.includes("教练课"));
  ok("重置:事件块 e-c 移除", !after09.includes("e-c@myagenda") && !after09.includes("例会"));
  ok("重置:跨月事件块 e-b 移除", !after10.includes("e-b@myagenda") && !after10.includes("假期"));

  // 账本清空(内存 + 落盘),游标一并清空
  eq("重置:内存账本清空", plugin.journal, { version: 2, calendars: {}, events: {} });
  const diskJournal = JSON.parse(files.get("Agenda/.myagenda/journal.json") ?? "{}") as SyncJournal;
  eq("重置:落盘账本 events 清空", Object.keys(diskJournal.events ?? {}), []);
  eq("重置:落盘账本 calendars 游标清空", Object.keys(diskJournal.calendars ?? {}), []);

  // 账号/密码/日历/lastSync 清空(settings 活对象 + data.json 通道双确认)
  eq("重置:settings.user 清空", plugin.settings.user, "");
  eq("重置:settings.password 清空", plugin.settings.password, "");
  eq("重置:settings.calendars 清空", plugin.settings.calendars, []);
  eq("重置:settings.lastSync 清空", plugin.settings.lastSync, undefined);
  eq("重置:data.json user 清空", h.plugin.savedData?.user, "");
  eq("重置:data.json calendars 清空", h.plugin.savedData?.calendars, []);
  eq("重置:data.json lastSync 清空", h.plugin.savedData?.lastSync, undefined);

  // 提示语:计数 = 笔记块 3 + 账本独有条目 1(pendingDelete 无块)= 4
  eq("重置:提示含计数 4", msg1, [t("notice.resetDone", { n: 4 })]);

  // 幂等:再重置一次,0 条,手写块不受影响
  const mark2 = notices.length;
  await plugin.resetAllSyncData();
  eq("重置:二次重置计数 0", notices.slice(mark2), [t("notice.resetDone", { n: 0 })]);
  ok("重置:二次重置手写块仍在", (files.get("Agenda/2026-09.md") ?? "").includes("手写随记(非日程块)"));

  // EMPTY_JOURNAL 深拷贝:重置后再 journalPut 绝不污染常量(bundle 内同一常量对象)
  ok("重置:plugin.journal 不共享 EMPTY_JOURNAL 引用", plugin.journal !== h.bundle.EMPTY_JOURNAL);
  h.bundle.journalPut(plugin.journal, "pollute@myagenda", { calendarId: "cal-x", state: "synced" });
  eq("重置:journalPut 已写入实例账本(桩自检)", Object.keys(plugin.journal.events), ["pollute@myagenda"]);
  eq("重置:EMPTY_JOURNAL 常量未被污染", Object.keys(h.bundle.EMPTY_JOURNAL.events), []);
}

// ════════════════════════ §2 清空日历本地日程(clearCalendarLocalEvents)════════════════════════
{
  const seed09 = [
    "## 10:00–11:00 教练课",
    "- id:: e-a@myagenda",
    "- starts:: 2026-09-29T10:00:00",
    "- ends:: 2026-09-29T11:00:00",
    "- allday:: false",
    "",
    "## 09:00–10:00 冲浪课",
    "- id:: e-b@myagenda",
    "- starts:: 2026-09-30T09:00:00",
    "- ends:: 2026-09-30T10:00:00",
    "- allday:: false",
    "",
    "## 14:00–15:00 例会",
    "- id:: e-c@myagenda",
    "- starts:: 2026-09-29T14:00:00",
    "- ends:: 2026-09-29T15:00:00",
    "- allday:: false",
  ].join("\n");
  const seedJournal = JSON.stringify({
    version: 2,
    calendars: {},
    events: {
      "e-a@myagenda": { calendarId: "cal-a", href: "https://cal.example.com/a/e-a.ics", etag: '"1"', state: "synced" },
      "e-b@myagenda": { calendarId: "cal-a", href: "https://cal.example.com/a/e-b.ics", etag: '"2"', state: "synced" },
      "e-d@myagenda": { calendarId: "cal-a", state: "pendingDelete" },
      "e-c@myagenda": { calendarId: "cal-b", href: "https://cal.example.com/b/e-c.ics", etag: '"3"', state: "synced" },
    },
  });

  const h = await makePlugin({
    data: baseData(),
    seed: { "Agenda/2026-09.md": seed09, "Agenda/.myagenda/journal.json": seedJournal },
  });
  const { plugin, files, notices } = h;

  eq("清空:账本预载 4 条", Object.keys(plugin.journal.events).length, 4);

  // 清 cal-a:e-a/e-b 块 + e-a/e-b/e-d(无块的 pendingDelete)账本条目;cal-b 的 e-c 不动
  const mark = notices.length;
  await plugin.clearCalendarLocalEvents({ id: "cal-a", name: "个人" });
  const text1 = files.get("Agenda/2026-09.md") ?? "";
  eq("清空:提示已清 3 条(含无块的账本条目)", notices.slice(mark), [t("notice.clearDone", { n: 3 })]);
  ok("清空:e-c 块保留", text1.includes("e-c@myagenda") && text1.includes("例会"));
  ok("清空:e-a/e-b 块移除", !text1.includes("e-a@myagenda") && !text1.includes("e-b@myagenda") && !text1.includes("冲浪课"));
  eq("清空:内存账本只剩 cal-b 条目", Object.keys(plugin.journal.events), ["e-c@myagenda"]);
  const disk1 = JSON.parse(files.get("Agenda/.myagenda/journal.json") ?? "{}") as SyncJournal;
  eq("清空:落盘账本只剩 cal-b 条目", Object.keys(disk1.events ?? {}), ["e-c@myagenda"]);

  // 再清一次 cal-a:已无条目 → 仅提示,不动数据
  const mark2 = notices.length;
  await plugin.clearCalendarLocalEvents({ id: "cal-a", name: "个人" });
  eq("清空:二次清空提示无日程", notices.slice(mark2), [t("notice.clearNone")]);
  eq("清空:二次清空账本不变", Object.keys(plugin.journal.events), ["e-c@myagenda"]);

  // 未知日历 id:同样提示无日程,数据不变
  const mark3 = notices.length;
  await plugin.clearCalendarLocalEvents({ id: "cal-zz", name: "不存在" });
  eq("清空:未知日历提示无日程", notices.slice(mark3), [t("notice.clearNone")]);
  eq("清空:未知日历账本不变", Object.keys(plugin.journal.events), ["e-c@myagenda"]);

  // 清 cal-b:最后一条也移除
  const mark4 = notices.length;
  await plugin.clearCalendarLocalEvents({ id: "cal-b", name: "工作" });
  eq("清空:cal-b 提示已清 1 条", notices.slice(mark4), [t("notice.clearDone", { n: 1 })]);
  eq("清空:账本全空", Object.keys(plugin.journal.events), []);
  ok("清空:月文件无事件块", !(files.get("Agenda/2026-09.md") ?? "").includes("- id::"));
}

// ════════════════════════ §3 停用日历三选语义补充:重新启用后事件收养/推送 ═════════════════════════
// (selftest8 已验证停用期间零推送零删除;这里验证重新启用后的恢复行为)
const memIO = (): KeyValueFileIO => {
  const files = new Map<string, string>();
  return {
    async readText(p) { return files.get(p) ?? null; },
    async writeText(p, c) { files.set(p, c); },
    async remove(p) { files.delete(p); },
    async listFiles(dir) { return [...files.keys()].filter((k) => k.startsWith(dir + "/")); },
    async ensureDir() {},
  };
};
interface Call { method: string; url: string }
const multistatus = (items: { href: string; etag: string; ics: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
  items.map((it) =>
    `<d:response><d:href>${it.href}</d:href><d:propstat><d:prop>` +
    `<d:getetag>${it.etag}</d:getetag><c:calendar-data>${it.ics}</c:calendar-data>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("") +
  `</d:multistatus>`;
const makeServer = () => {
  const store = new Map<string, { ics: string; etag: string }>();
  let seq = 0;
  const calls: Call[] = [];
  const http: Http = async (opts) => {
    calls.push({ method: opts.method, url: opts.url });
    if (opts.method === "REPORT") {
      const items = [...store.entries()].filter(([hh]) => hh.startsWith(opts.url)).map(([hh, v]) => ({ href: hh, etag: v.etag, ics: v.ics }));
      return { status: 207, text: multistatus(items), headers: {} };
    }
    if (opts.method === "PUT") {
      const etag = `"s${++seq}"`;
      store.set(opts.url, { ics: opts.body ?? "", etag });
      return { status: 201, text: "", headers: { ETag: etag } };
    }
    if (opts.method === "DELETE") { store.delete(opts.url); return { status: 204, text: "", headers: {} }; }
    return { status: 200, text: "", headers: {} };
  };
  return {
    calls, http, store,
    seed(url: string, ics: string) { store.set(url, { ics, etag: `"s${++seq}"` }); },
    writes: () => calls.filter((c) => c.method === "PUT" || c.method === "DELETE"),
  };
};
const icsOf = (uid: string, title: string, start: string, end: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//selftest9//CN", "BEGIN:VEVENT",
    `UID:${uid}`, "DTSTAMP:20260928T000000Z", `SUMMARY:${title}`, `DTSTART:${start}`, `DTEND:${end}`,
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");

const AUTH = { user: "u", pass: "p" };
// 停用期间 routes 不含 classRoute;重新启用 = routes 恢复包含它
const classRoute: CalendarRoute = { id: "cal-class", url: "https://cal.example.com/class/", name: "上课", category: "上课", auth: AUTH };
const freshJournal = (): SyncJournal => JSON.parse(JSON.stringify({ version: 2, calendars: {}, events: {} })) as SyncJournal;
const makeEngine = (server: ReturnType<typeof makeServer>, journal: SyncJournal, notes: MonthlyNoteStore) =>
  new SyncEngine({
    http: server.http,
    routes: [classRoute], // 重新启用后的路由表
    notes, journal,
    saveJournal: async () => {},
    askConflict: async () => "mine",
    notify: () => {},
    sleep: async () => {},
  });

// 3a. 停用期间的本地改动(selftest8 §2 场景延续:账本条目仍在)→ 重新启用后推送回原 href
{
  const server = makeServer();
  const notes = new MonthlyNoteStore(memIO(), "Agenda");
  const orig: CalendarEvent = { id: "e1@myagenda", title: "教练课", startsAt: "2026-09-29T09:00:00", endsAt: "2026-09-29T10:00:00", isAllDay: false, category: "上课" };
  const modified: CalendarEvent = { ...orig, title: "教练课(本地已改)" };
  await notes.writeMonth("2026-09", [modified], "");
  const journal = freshJournal();
  journal.events["e1@myagenda"] = { calendarId: "cal-class", href: classRoute.url + "e1.ics", etag: '"old"', pushedFingerprint: await contentFingerprint(orig), state: "synced" };
  server.seed(classRoute.url + "e1.ics", icsOf("e1@myagenda", "教练课(远端未变)", "20260929T090000", "20260929T100000"));
  const s = await makeEngine(server, journal, notes).run();
  eq("重新启用:识别冲突", s.conflicts, 1);
  eq("重新启用:本地改动推送 1 条", s.pushed, 1);
  eq("重新启用:零删除", server.calls.filter((c) => c.method === "DELETE").length, 0);
  eq("重新启用:PUT 到原 href", server.calls.find((c) => c.method === "PUT")?.url, classRoute.url + "e1.ics");
  ok("重新启用:服务器内容为本地版", (server.store.get(classRoute.url + "e1.ics")?.ics ?? "").includes("本地已改"));
  ok("重新启用:账本 etag 已刷新", journal.events["e1@myagenda"]?.etag !== '"old"');
  eq("重新启用:推送指纹=本地版本", journal.events["e1@myagenda"]?.pushedFingerprint, await contentFingerprint(modified));
  eq("重新启用:本地改动未丢", (await notes.loadAll()).events[0]?.title, "教练课(本地已改)");
}

// 3b. 停用期间账本条目丢失(本地块还在)→ 重新启用后收养:内容一致只登记,零远端写
{
  const server = makeServer();
  const notes = new MonthlyNoteStore(memIO(), "Agenda");
  const icsE2 = icsOf("e2@myagenda", "体检", "20260929T140000", "20260929T150000");
  const localE2 = parseIcsToEvents(icsE2)[0] as CalendarEvent;
  await notes.writeMonth("2026-09", [localE2], "");
  const journal = freshJournal();
  server.seed(classRoute.url + "e2.ics", icsE2);
  const s = await makeEngine(server, journal, notes).run();
  eq("收养:内容一致 adopted=1", s.adopted, 1);
  eq("收养:零推送", s.pushed, 0);
  eq("收养:零拉取", s.pulled, 0);
  eq("收养:零远端写", server.writes().length, 0);
  eq("收养:归属上课日历", journal.events["e2@myagenda"]?.calendarId, "cal-class");
  eq("收养:登记 href/etag", [journal.events["e2@myagenda"]?.href, journal.events["e2@myagenda"]?.etag, journal.events["e2@myagenda"]?.state], [classRoute.url + "e2.ics", '"s1"', "synced"]);
  eq("收养:登记指纹=内容指纹", journal.events["e2@myagenda"]?.pushedFingerprint, await contentFingerprint(localE2));
  const before2 = server.writes().length;
  const s2 = await makeEngine(server, journal, notes).run();
  eq("收养:第二轮收敛零写", server.writes().length - before2, 0);
  eq("收养:第二轮不重复收养", s2.adopted, 0);
}

// 3c. 停用期间账本条目丢失且本地已改 → 收养后本地版优先推送
{
  const server = makeServer();
  const notes = new MonthlyNoteStore(memIO(), "Agenda");
  const icsE3 = icsOf("e3@myagenda", "复诊", "20260930T100000", "20260930T110000");
  const localE3 = { ...(parseIcsToEvents(icsE3)[0] as CalendarEvent), title: "复诊(本地新版)" };
  await notes.writeMonth("2026-09", [localE3], "");
  const journal = freshJournal();
  server.seed(classRoute.url + "e3.ics", icsE3);
  const s = await makeEngine(server, journal, notes).run();
  eq("收养分歧:adopted=1", s.adopted, 1);
  eq("收养分歧:本地版推送 1 条", s.pushed, 1);
  ok("收养分歧:服务器被本地版覆盖", (server.store.get(classRoute.url + "e3.ics")?.ics ?? "").includes("本地新版"));
  eq("收养分歧:登记指纹=本地版本", journal.events["e3@myagenda"]?.pushedFingerprint, await contentFingerprint(localE3));
  const before2 = server.writes().length;
  await makeEngine(server, journal, notes).run();
  eq("收养分歧:第二轮收敛零写", server.writes().length - before2, 0);
}

// ════════════════════════ §4 status 落盘往返 + 指纹差异触发 localDirty ═════════════════════════
{
  const evCancel: CalendarEvent = { id: "e1@myagenda", title: "牙医", startsAt: "2026-09-29T10:00:00", endsAt: "2026-09-29T11:00:00", isAllDay: false, status: "cancelled" };
  const roundTrip = (text: string): CalendarEvent | null => {
    const blocks = parseMonthlyNote(text).blocks;
    return blocks.length ? blockToEvent(blocks[blocks.length - 1] as NonNullable<typeof blocks[number]>) : null;
  };

  // 全新块(编辑器新存/同步新建):status 必须落盘
  const fresh = serializeBlock(evCancel);
  ok("status:全新落盘含 - status:: cancelled", fresh.includes("- status:: cancelled"));
  eq("status:全新往返保留 cancelled", roundTrip(fresh)?.status, "cancelled");

  // 既有块:status 变更必须落盘为新值(而非旧值的透传)
  const noteConfirmed = [
    "## 10:00–11:00 牙医",
    "- id:: e1@myagenda",
    "- starts:: 2026-09-29T10:00:00",
    "- ends:: 2026-09-29T11:00:00",
    "- allday:: false",
    "- status:: confirmed",
  ].join("\n");
  const existing = parseMonthlyNote(noteConfirmed).blocks[0];
  const reser = serializeBlock(evCancel, existing);
  ok("status:变更落盘为新值 cancelled", reser.includes("- status:: cancelled"));
  eq("status:变更往返保留 cancelled", roundTrip(reser)?.status, "cancelled");

  // 同值重写:保留(当前经旧值透传实现,行为正确但路径脆弱,一并钉住)
  const same = serializeBlock(evCancel, parseMonthlyNote(noteConfirmed.replace("confirmed", "cancelled")).blocks[0]);
  eq("status:同值重写保留", roundTrip(same)?.status, "cancelled");

  // 指纹:status 变化必须产生差异(否则同步层感知不到取消状态)
  const fpCancelled = await contentFingerprint(evCancel);
  eq("指纹:cancelled ≠ confirmed", fpCancelled === (await contentFingerprint({ ...evCancel, status: "confirmed" })), false);
  eq("指纹:cancelled ≠ 无status", fpCancelled === (await contentFingerprint({ ...evCancel, status: undefined })), false);
  // 引擎 localDirty 判定镜像:账本指纹=旧状态,事件改为 cancelled → localDirty
  const fpBefore = await contentFingerprint({ ...evCancel, status: undefined });
  const localDirty = (await contentFingerprint(evCancel)) !== fpBefore;
  eq("指纹:status 变化触发 localDirty", localDirty, true);
}

// ════════════════════════ §5 notes 转义对称性(escapeText/unescapeText 经公共路径)════════════════════════
{
  const roundTripNotes = (notes: string) => {
    const ev: CalendarEvent = { id: "n1@myagenda", title: "笔记", startsAt: "2026-09-29T10:00:00", endsAt: "2026-09-29T11:00:00", isAllDay: false, notes };
    const text = serializeBlock(ev);
    const blocks = parseMonthlyNote(text).blocks;
    return { text, notes: blockToEvent(blocks[blocks.length - 1] as NonNullable<typeof blocks[number]>)?.notes };
  };

  // 多行:落盘必须是字面 \n 两字符,读回还原真换行(contenteditable 换行保存的根基)
  const r1 = roundTripNotes("第一行\n第二行");
  eq("notes:多行往返还原", r1.notes, "第一行\n第二行");
  ok("notes:落盘为字面 \\n 转义", r1.text.includes("第一行\\n第二行"));
  ok("notes:落盘无裸换行", !r1.text.includes("第一行\n第二行"));

  // Windows 路径:反斜杠+n 是两个字面字符,绝不能被吞成换行(经典双转义 bug 位)
  const r2 = roundTripNotes("C:\\new\\notes");
  eq("notes:反斜杠+n 不吞并", r2.notes, "C:\\new\\notes");

  // 尾部反斜杠
  const r3 = roundTripNotes("结尾反斜杠\\");
  eq("notes:尾部反斜杠往返", r3.notes, "结尾反斜杠\\");

  // 反斜杠+字面 n+真换行混合
  const r4 = roundTripNotes("C:\\tmp\\日志\\n结束于反斜杠\\");
  eq("notes:混合转义往返", r4.notes, "C:\\tmp\\日志\\n结束于反斜杠\\");

  // 多行与反斜杠并存
  const r5 = roundTripNotes("路径 C:\\new\n换行后\nC:\\test");
  eq("notes:多行+反斜杠往返", r5.notes, "路径 C:\\new\n换行后\nC:\\test");
}

// 回归：关闭重复日程移动弹窗必须不写入；ICS 源删除仅清理订阅事件。
{
  const h = await makePlugin({ data: { provider: "none", folder: "Agenda", injectEnabled: false } });
  const plugin = h.plugin as any;
  const ev: CalendarEvent = { id: "ics-regression", title: "订阅会议", startsAt: "2026-10-15T09:00:00", endsAt: "2026-10-15T10:00:00", isAllDay: false };
  await plugin.writeAll([ev, { ...ev, id: "local-event", title: "本地会议" }]);
  await plugin.writeAll([], false);
  eq("解析不完整时保留订阅旧日程", (await plugin.notes.loadAll()).events.length, 2);
  await plugin.writeAll([]);
  eq("ICS 源删除传播到本地", (await plugin.notes.loadAll()).events.map((x: CalendarEvent) => x.id), ["local-event"]);
  await plugin.writeAll([ev]);
  await plugin.writeAll([{ ...ev, startsAt: "2026-11-15T09:00:00", endsAt: "2026-11-15T10:00:00" }]);
  eq("ICS 跨月移动没有旧副本", (await plugin.notes.loadAll()).events.filter((x: CalendarEvent) => x.id === ev.id).map((x: CalendarEvent) => x.startsAt), ["2026-11-15T09:00:00"]);
  const recurring = { ...ev, repeats: { rule: "FREQ=DAILY;COUNT=3" } };
  plugin.loadEvents = async () => [recurring];
  let saves = 0;
  plugin.saveEventsList = async () => { saves++; };
  await plugin.onMoveToDay({ event: recurring, start: ev.startsAt, end: ev.endsAt }, new Date(2026, 9, 16));
  eq("取消月视图拖动不保存", saves, 0);
}

// 例外实例编辑/删除必须只更新主系列内对应实例。
{
  const h = await makePlugin({ data: { provider: "none", folder: "Agenda", injectEnabled: false } });
  const plugin = h.plugin as any;
  const master: CalendarEvent = { id: "series-edit", title: "系列", startsAt: "2026-10-15T09:00:00", endsAt: "2026-10-15T10:00:00", isAllDay: false, repeats: { rule: "FREQ=DAILY;COUNT=3" } };
  const override: CalendarEvent = { ...master, repeats: undefined, title: "例外", startsAt: "2026-10-16T14:00:00", endsAt: "2026-10-16T15:00:00", recurrenceId: "2026-10-16T09:00:00" };
  await plugin.saveEventsList([{ ...master, recurrenceOverrides: [override] }]);
  await plugin.saveEventsList([{ ...override, title: "例外编辑后" }]);
  let saved: CalendarEvent = (await plugin.notes.loadAll()).events[0];
  eq("例外编辑保留主系列规则", saved.repeats?.rule, master.repeats?.rule);
  eq("例外编辑保留主系列起点", saved.startsAt, master.startsAt);
  eq("例外编辑保存标题", saved.recurrenceOverrides?.[0].title, "例外编辑后");
  await plugin.deleteEvent(saved.recurrenceOverrides![0]);
  saved = (await plugin.notes.loadAll()).events[0];
  eq("删除例外不删除主系列", saved.id, master.id);
  eq("删除例外写入单次取消状态", saved.recurrenceOverrides?.[0].status, "cancelled");
}

console.log(`九轮自检:${pass} 通过,${fails.length} 失败`);
for (const f of fails) console.log("  ✗", f);
if (fails.length) process.exit(1);
