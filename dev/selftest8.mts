// 第八轮自检:分类跟随日历映射 / 停用日历不回写远端 / 同名日历去重 / resolveLang / calendar-color / 注入格式收敛
// 运行:npx tsx dev/selftest8.mts
// 说明:engine.ts→dav.ts 顶层 import "obsidian"(仅 requestUrl,测试注入自建 http 桩),
// 而 node_modules 的 obsidian 包无 main,tsx(CJS require 路径)下解析失败——
// 在动态 import 引擎前挂 Module._resolveFilename 钩子指向本地桩 dev/obsidian-cjs-stub.cjs。
import Module from "node:module";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { JSDOM } = req("jsdom");
(globalThis as { DOMParser?: unknown }).DOMParser = new JSDOM().window.DOMParser;
const stubPath = req.resolve("./obsidian-cjs-stub.cjs");
const origResolve = (Module as unknown as {
  _resolveFilename: (this: unknown, request: string, parent: unknown, ...rest: unknown[]) => string;
})._resolveFilename;
(Module as unknown as { _resolveFilename: unknown })._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "obsidian") return stubPath;
  return origResolve.call(this, request, ...rest);
} as never;

const { SyncEngine } = await import("../src/sync/engine.ts");
const { parseCalendarCollection } = await import("../src/sync/dav.ts");
import { sanitize, DEFAULTS, resolveLang } from "../src/kernel/settings.ts";
import { MonthlyNoteStore } from "../src/data/note-store.ts";
import { EMPTY_JOURNAL } from "../src/data/journal.ts";
import { contentFingerprint } from "../src/model/content-fingerprint.ts";
import { parseIcsToEvents } from "../src/sync/ical.ts";
import type { CalendarEvent } from "../src/model/event.ts";
import type { KeyValueFileIO } from "../src/data/io.ts";
import type { SyncJournal } from "../src/data/journal.ts";
import type { Http } from "../src/sync/dav.ts";
import type { CalendarRoute } from "../src/sync/engine.ts";

let pass = 0; const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else fails.push(`${name}: got ${g}, want ${w}`);
};
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`${name}${detail ? ": " + detail : ""}`);
};

// ── 桩:内存文件系统 + 内存 CalDAV 服务器(PUT 改内容并推进 etag,行为贴近真实服务器)──
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
      const items = [...store.entries()].filter(([h]) => h.startsWith(opts.url)).map(([href, v]) => ({ href, etag: v.etag, ics: v.ics }));
      return { status: 207, text: multistatus(items), headers: {} };
    }
    if (opts.method === "PUT") {
      const etag = `"s${++seq}"`;
      store.set(opts.url, { ics: opts.body ?? "", etag });
      return { status: 201, text: "", headers: { ETag: etag } };
    }
    if (opts.method === "DELETE") { store.delete(opts.url); return { status: 204, text: "", headers: {} }; }
    if (opts.method === "GET") {
      const hit = store.get(opts.url);
      return hit ? { status: 200, text: hit.ics, headers: { ETag: hit.etag } } : { status: 404, text: "", headers: {} };
    }
    return { status: 200, text: "", headers: {} };
  };
  return {
    calls, http, store,
    seed(url: string, ics: string) { store.set(url, { ics, etag: `"s${++seq}"` }); },
    writes: () => calls.filter((c) => c.method === "PUT" || c.method === "DELETE"),
  };
};

const icsOf = (uid: string, title: string, start: string, end: string, categories?: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//selftest8//CN", "BEGIN:VEVENT",
    `UID:${uid}`, "DTSTAMP:20260928T000000Z", `SUMMARY:${title}`, `DTSTART:${start}`, `DTEND:${end}`,
    ...(categories ? [`CATEGORIES:${categories}`] : []),
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");

const AUTH = { user: "u", pass: "p" };
const classRoute: CalendarRoute = { id: "cal-class", url: "https://cal.example.com/class/", name: "上课", category: "上课", auth: AUTH };
const workRoute: CalendarRoute = { id: "cal-work", url: "https://cal.example.com/work/", name: "工作", category: "工作", auth: AUTH };
const freeRoute: CalendarRoute = { id: "cal-free", url: "https://cal.example.com/free/", name: "自由", category: "", auth: AUTH };

const makeEngine = (routes: CalendarRoute[], server: ReturnType<typeof makeServer>, journal: SyncJournal, notes: MonthlyNoteStore, conflictTitles: string[] = []) =>
  new SyncEngine({
    http: server.http,
    routes, notes, journal,
    saveJournal: async () => {},
    askConflict: async (info) => { conflictTitles.push(info.title); return "mine"; },
    notify: () => {},
    sleep: async () => {},
  });

const freshJournal = (): SyncJournal => JSON.parse(JSON.stringify(EMPTY_JOURNAL)) as SyncJournal;

// ═══ 1. 分类跟随日历映射(toApply 应用前用所属日历 category 覆盖 VEVENT CATEGORIES)═══
{
  const ics = icsOf("e1@myagenda", "教练课", "20260929T100000", "20260929T110000", "工作");
  eq("分类跟随:夹具远端 CATEGORIES=工作", parseIcsToEvents(ics)[0]?.category, "工作");

  // 1a. 全新拉取:journal.calendarId 指向上课日历,远端 CATEGORIES=工作 → 本地应显示"上课"
  const server = makeServer();
  const notes = new MonthlyNoteStore(memIO(), "Agenda");
  const journal = freshJournal();
  const engine = makeEngine([classRoute, workRoute], server, journal, notes);
  server.seed(classRoute.url + "e1.ics", ics);
  const s1 = await engine.run();
  eq("分类跟随:拉取 1 条", s1.pulled, 1);
  eq("分类跟随:第一轮零远端写", server.writes().length, 0);
  const loaded = await notes.loadAll();
  eq("分类跟随:本地 1 条", loaded.events.length, 1);
  eq("分类跟随:本地分类被日历覆盖为上课", loaded.events[0]?.category, "上课");
  eq("分类跟随:其余字段来自远端", loaded.events[0]?.startsAt, "2026-09-29T10:00:00");
  eq("分类跟随:账本归属上课日历", journal.events["e1@myagenda"]?.calendarId, "cal-class");
  eq("分类跟随:账本 href", journal.events["e1@myagenda"]?.href, classRoute.url + "e1.ics");
  eq("分类跟随:落盘月份", s1.months, ["2026-09"]);

  // 1b. 存量事件远端变更(etag 变)→ 走 toApply 更新路径,同样覆盖分类
  const notesC = new MonthlyNoteStore(memIO(), "Agenda");
  const localC: CalendarEvent = { id: "e1@myagenda", title: "教练课", startsAt: "2026-09-29T09:00:00", endsAt: "2026-09-29T10:00:00", isAllDay: false, category: "上课" };
  await notesC.writeMonth("2026-09", [localC], "");
  const journalC = freshJournal();
  journalC.events["e1@myagenda"] = { calendarId: "cal-class", href: classRoute.url + "e1.ics", etag: '"old"', pushedFingerprint: await contentFingerprint(localC), state: "synced" };
  const serverC = makeServer();
  serverC.seed(classRoute.url + "e1.ics", ics); // 同一 ICS:10:00 + CATEGORIES 工作
  const engineC = makeEngine([classRoute, workRoute], serverC, journalC, notesC);
  const sC = await engineC.run();
  eq("更新路径:拉取 1 条", sC.pulled, 1);
  eq("更新路径:零远端写", serverC.writes().length, 0);
  const loadedC = await notesC.loadAll();
  eq("更新路径:时刻随远端更新", loadedC.events[0]?.startsAt, "2026-09-29T10:00:00");
  eq("更新路径:分类仍被日历覆盖为上课", loadedC.events[0]?.category, "上课");

  // 1c. 日历 category 为空:不覆盖,保留远端 CATEGORIES
  const serverB = makeServer();
  const notesB = new MonthlyNoteStore(memIO(), "Agenda");
  serverB.seed(freeRoute.url + "e2.ics", icsOf("e2@myagenda", "体检", "20260929T140000", "20260929T150000", "个人"));
  const engineB = makeEngine([freeRoute], serverB, freshJournal(), notesB);
  const sB = await engineB.run();
  eq("空分类:拉取 1 条", sB.pulled, 1);
  const loadedB = await notesB.loadAll();
  eq("空分类:保留远端 CATEGORIES", loadedB.events[0]?.category, "个人");
  eq("空分类:零远端写", serverB.writes().length, 0);

  // 1d. 收敛观察:分类覆盖发生在指纹登记之后 → 下一轮判 localDirty 把覆盖后的分类推回服务器
  // (当前行为:恰好一次额外 PUT;第三轮起收敛。该副作用详见审查报告)
  const before2 = server.writes().length;
  await engine.run();
  eq("分类跟随:第二轮零写入(指纹已回写,无冗余推送)", server.writes().length - before2, 0);
  const before3 = server.writes().length;
  await engine.run();
  eq("分类跟随:第三轮收敛零写入", server.writes().length - before3, 0);
}

// ═══ 2. 停用日历(routes 不含)的事件变更:不推送也不删除远端 ═══
{
  const server = makeServer();
  const notes = new MonthlyNoteStore(memIO(), "Agenda");
  const orig: CalendarEvent = { id: "e1@myagenda", title: "教练课", startsAt: "2026-09-29T09:00:00", endsAt: "2026-09-29T10:00:00", isAllDay: false, category: "上课" };
  const modified: CalendarEvent = { ...orig, title: "教练课(本地已改)" };
  await notes.writeMonth("2026-09", [modified], "");
  const journal = freshJournal();
  journal.events["e1@myagenda"] = { calendarId: "cal-class", href: classRoute.url + "e1.ics", etag: '"old"', pushedFingerprint: await contentFingerprint(orig), state: "synced" };
  // 上课日历已停用:routes 只剩工作日历(其扫描结果不含 e1)
  const conflicts: string[] = [];
  const engine = makeEngine([workRoute], server, journal, notes, conflicts);
  const s = await engine.run();
  eq("停用日历:零 PUT", server.calls.filter((c) => c.method === "PUT").length, 0);
  eq("停用日历:零 DELETE", server.calls.filter((c) => c.method === "DELETE").length, 0);
  eq("停用日历:零推送零删除计数", [s.pushed, s.created, s.deleted], [0, 0, 0]);
  const loaded = await notes.loadAll();
  eq("停用日历:本地改动原样保留", loaded.events[0]?.title, "教练课(本地已改)");
  ok("停用日历:账本条目未丢", !!journal.events["e1@myagenda"]);
  eq("停用日历:不走冲突询问(静默保留,无 theirs 可比)", conflicts, []);
}

// ═══ 3. 同名日历去重(sanitizeCalendars):同名保留最后一条;无名日历不参与去重 ═══
{
  const s1 = sanitize({ calendars: [
    { id: "old", url: "https://old.icloud.com/pers/", name: "个人", category: "个人" },
    { id: "new", url: "https://new.icloud.com.cn/pers/", name: "个人", category: "个人" },
  ] });
  eq("同名去重:只留 1 条", s1.calendars.length, 1);
  eq("同名去重:保留最后一条", s1.calendars[0]?.id, "new");
  eq("同名去重:URL 是新域名", s1.calendars[0]?.url, "https://new.icloud.com.cn/pers/");

  const s2 = sanitize({ calendars: [
    { id: "a", url: "https://x.example.com/1/", name: "" },
    { id: "b", url: "https://x.example.com/2/", name: "" },
    { id: "c", url: "https://x.example.com/3/", name: "工作" },
    { id: "d", url: "https://x.example.com/4/", name: "工作" },
    { id: "e", url: "", name: "无址丢弃" },
  ] });
  eq("无名不参与去重:3 条", s2.calendars.length, 3);
  eq("无名日历都在", s2.calendars.filter((c) => !c.name).length, 2);
  eq("同名有名保留最后", s2.calendars.find((c) => c.name === "工作")?.id, "d");
  ok("无 url 丢弃", !s2.calendars.some((c) => c.name === "无址丢弃"));
}

// ═══ 4. dav.ts parseCalendarCollection:calendar-color 解析 ═══
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ia="http://apple.com/ns/ical/">` +
    `<d:response><d:href>/cal/red/</d:href><d:propstat><d:prop>` +
    `<d:displayname>红色</d:displayname>` +
    `<d:resourcetype><d:collection/><d:calendar/></d:resourcetype>` +
    `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>` +
    `<ia:calendar-color>#FF3B30B2</ia:calendar-color>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
    `<d:response><d:href>/cal/plain/</d:href><d:propstat><d:prop>` +
    `<d:displayname>无色</d:displayname>` +
    `<d:resourcetype><d:collection/><d:calendar/></d:resourcetype>` +
    `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
    `<d:response><d:href>/cal/lower/</d:href><d:propstat><d:prop>` +
    `<d:displayname>小写</d:displayname>` +
    `<d:resourcetype><d:collection/><d:calendar/></d:resourcetype>` +
    `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>` +
    `<ia:calendar-color>#5856d6ff</ia:calendar-color>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
    `</d:multistatus>`;
  const cals = parseCalendarCollection(xml, "https://caldav.example.com/");
  eq("color:3 个日历都保留", cals.length, 3);
  eq("color:#RRGGBBAA → #RRGGBB", cals.find((c) => c.name === "红色")?.color, "#FF3B30");
  eq("color:无颜色属性 → undefined", cals.find((c) => c.name === "无色")?.color, undefined);
  eq("color:小写透明度同样截取", cals.find((c) => c.name === "小写")?.color, "#5856d6");
  eq("color:id 取路径末段", cals.find((c) => c.name === "红色")?.id, "red");
}

// ═══ 5. 注入格式设置收敛(sanitize):injectPrefix 只认 > / >>;injectTimeFormat 只认 24h / 12h ═══
{
  eq("prefix:> 保留", sanitize({ injectPrefix: ">" }).injectPrefix, ">");
  eq("prefix:>> 保留", sanitize({ injectPrefix: ">>" }).injectPrefix, ">>");
  eq("prefix:>>> 收敛 >>", sanitize({ injectPrefix: ">>>" }).injectPrefix, ">>");
  eq("prefix:空串走默认 >>", sanitize({ injectPrefix: "" }).injectPrefix, ">>");
  eq("prefix:乱值走默认 >>", sanitize({ injectPrefix: "- " }).injectPrefix, ">>");
  eq("prefix:缺省 >>", sanitize({}).injectPrefix, ">>");
  eq("prefix:非字符串走默认 >>", sanitize({ injectPrefix: 3 }).injectPrefix, ">>");
  eq("time:12h 保留", sanitize({ injectTimeFormat: "12h" }).injectTimeFormat, "12h");
  eq("time:24h 保留", sanitize({ injectTimeFormat: "24h" }).injectTimeFormat, "24h");
  eq("time:乱值收敛 24h", sanitize({ injectTimeFormat: "ampm" }).injectTimeFormat, "24h");
  eq("time:缺省 24h", sanitize({}).injectTimeFormat, "24h");
}

// ═══ 6. resolveLang 三级:显式设置 > Obsidian locale(zh*) > 默认 en ═══
{
  const base = { ...DEFAULTS };
  eq("lang:显式 zh 优先于 locale", resolveLang({ ...base, lang: "zh" }, "en-US"), "zh");
  eq("lang:显式 en 优先于 locale", resolveLang({ ...base, lang: "en" }, "zh-CN"), "en");
  eq("lang:auto + zh-CN → zh", resolveLang({ ...base, lang: "auto" }, "zh-CN"), "zh");
  eq("lang:auto + en-US → en", resolveLang({ ...base, lang: "auto" }, "en-US"), "en");
  eq("lang:auto + 无 locale → en", resolveLang({ ...base, lang: "auto" }, undefined), "en");
  eq("lang:auto + ZH-tw(大小写) → zh", resolveLang({ ...base, lang: "auto" }, "ZH-tw"), "zh");
  eq("lang:非法值 sanitize 回 auto", sanitize({ lang: "jp" }).lang, "auto");
}

console.log(`八轮自检:${pass} 通过,${fails.length} 失败`);
for (const f of fails) console.log("  ✗", f);
if (fails.length) process.exit(1);
