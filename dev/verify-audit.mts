// 独立验证脚本:对 myagenda-v2 当前代码做黑盒往返验证(不预设历史修复)。
// 运行:npx tsx dev/verify-audit.mts
import {
  parseMonthlyNote,
  blockToEvent,
  serializeBlock,
  serializeRawBlock,
  serializeMonthlyNote,
  eventToFields,
} from "../src/data/note-format.ts";
import { MonthlyNoteStore } from "../src/data/note-store.ts";
import type { KeyValueFileIO } from "../src/data/io.ts";
import { parseIcsToEvents } from "../src/sync/ical.ts";
import { buildIcs } from "../src/core/ics-export.ts";
import { expandOccurrences } from "../src/core/occurrences.ts";
import { sanitize } from "../src/kernel/settings.ts";
import { contentFingerprint } from "../src/model/content-fingerprint.ts";
import type { CalendarEvent } from "../src/model/event.ts";

let pass = 0;
const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${name}`); }
  else { fails.push(`${name}\n    got:  ${g}\n    want: ${w}`); console.log(`  FAIL  ${name}\n    got:  ${g}\n    want: ${w}`); }
};
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fails.push(`${name}${detail ? "\n    " + detail : ""}`); console.log(`  FAIL  ${name}${detail ? "\n    " + detail : ""}`); }
};
const noteRoundtrip = (ev: CalendarEvent): { ev2: CalendarEvent | null; text: string } => {
  const text = serializeBlock(ev);
  const parsed = parseMonthlyNote(text);
  return { ev2: parsed.blocks.length ? blockToEvent(parsed.blocks[0]) : null, text };
};

console.log(`[env] TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

// ═══════════════ A. 多行备注完整往返 ═══════════════
console.log("\n=== A. 多行备注往返(含 \\n、反斜杠、特殊字符)===");
const trickyNotes = [
  "第一行",
  "第二行含反斜杠 C:\\Users\\test\\notes",
  "反斜杠加n 字面: a\\nb (literal backslash-n)",
  "",
  "- id:: fake-field-injection-attempt",
  "- starts:: 2020-01-01T00:00:00",
  "分号; 逗号, 冒号: emoji 🎉 tab\t字符",
  "最后一行",
].join("\n");
const evNotes: CalendarEvent = {
  id: "notes-1@myagenda", title: "备注往返", startsAt: "2026-03-02T10:00:00",
  endsAt: "2026-03-02T11:00:00", isAllDay: false, place: "地点A", category: "工作",
  notes: trickyNotes, reminderMinutes: [10, 30],
};
{
  // A1 笔记往返
  const { ev2, text } = noteRoundtrip(evNotes);
  eq("A1a notes 原样还原", ev2?.notes, trickyNotes);
  eq("A1b title", ev2?.title, "备注往返");
  eq("A1c place", ev2?.place, "地点A");
  eq("A1d category", ev2?.category, "工作");
  eq("A1e reminderMinutes", ev2?.reminderMinutes, [10, 30]);
  ok("A1f 落盘文件结构:备注不产生伪字段行", !/^-\s+(id|starts)::/m.test(text.split("\n\n").slice(1).join("\n\n")) || !text.includes("\n\n- id::"), text);
  // A2 ICS 往返(export → ical.js parse)
  const back = parseIcsToEvents(buildIcs([evNotes]))[0];
  eq("A2a ICS notes 原样还原", back?.notes, trickyNotes);
  eq("A2b ICS title", back?.title, "备注往返");
  eq("A2c ICS place", back?.place, "地点A");
  eq("A2d ICS category", back?.category, "工作");
  eq("A2e ICS reminderMinutes", back?.reminderMinutes, [10, 30]);
  // A3 全链:ICS → 事件 → 笔记 → 读回
  const { ev2: ev3 } = noteRoundtrip(back!);
  eq("A3 全链 notes", ev3?.notes, trickyNotes);
  // A4 恶意 place(换行注入字段)
  const evInj: CalendarEvent = { ...evNotes, id: "inj@x", place: "x\n- id:: forged\n- starts:: 2020-01-01T00:00:00" };
  const { text: injText, ev2: evInjBack } = noteRoundtrip(evInj);
  ok("A4 place 换行注入被压平", !/^-\s+id::\s*forged$/m.test(injText), injText);
  eq("A4b 注入不生效(id 不变)", evInjBack?.id, "inj@x");
}

// ═══════════════ B. status=cancelled 往返 ═══════════════
console.log("\n=== B. status=cancelled 序列化→解析往返 ===");
{
  const ev: CalendarEvent = { id: "st@x", title: "取消的事件", startsAt: "2026-03-02T10:00:00", endsAt: "2026-03-02T11:00:00", isAllDay: false, status: "cancelled" };
  const { ev2, text } = noteRoundtrip(ev);
  eq("B1 笔记往返 status", ev2?.status, "cancelled");
  ok("B2 落盘含 status:: cancelled", text.includes("- status:: cancelled"), text);
  const back = parseIcsToEvents(buildIcs([ev]))[0];
  eq("B3 ICS 往返 status", back?.status, "cancelled");
  const { ev2: ev3 } = noteRoundtrip(back!);
  eq("B4 全链 status", ev3?.status, "cancelled");
  // B5 status 变体
  for (const s of ["confirmed", "tentative"]) {
    const e: CalendarEvent = { ...ev, status: s };
    const r = noteRoundtrip(e);
    eq(`B5 status=${s} 往返`, r.ev2?.status, s);
  }
  // B6 status 清空场景:事件不再带 status,但旧块有 status::cancelled
  const oldText = serializeBlock(ev);
  const oldBlock = parseMonthlyNote(oldText).blocks[0];
  const cleared: CalendarEvent = { id: ev.id, title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt, isAllDay: false }; // status 已被清掉
  const rewrited = serializeBlock(cleared, oldBlock);
  ok("B6 status 清空后旧 status 不应残留", !rewrited.includes("status::"), rewrited);
}

// ═══════════════ C. EXDATE 往返 ═══════════════
console.log("\n=== C. EXDATE 导出→ical.js 解析往返 ===");
{
  // C1 全天
  const ad: CalendarEvent = { id: "exd-a@x", title: "全天重复", startsAt: "2026-03-02", endsAt: "2026-03-03", isAllDay: true, repeats: { rule: "FREQ=WEEKLY" }, skippedDates: ["2026-03-09"] };
  const icsA = buildIcs([ad]);
  ok("C1a 导出 EXDATE;VALUE=DATE", icsA.includes("EXDATE;VALUE=DATE:20260309"), icsA);
  const backA = parseIcsToEvents(icsA)[0];
  eq("C1b 解析 skippedDates", backA?.skippedDates, ["2026-03-09"]);
  // C2 定时
  const td: CalendarEvent = { id: "exd-t@x", title: "定时重复", startsAt: "2026-03-02T10:30:00", endsAt: "2026-03-02T11:30:00", isAllDay: false, repeats: { rule: "FREQ=WEEKLY" }, skippedDates: ["2026-03-09T10:30:00"] };
  const icsT = buildIcs([td]);
  ok("C2a 导出 EXDATE DATE-TIME", icsT.includes("EXDATE:20260309T103000"), icsT);
  const backT = parseIcsToEvents(icsT)[0];
  eq("C2b 解析 skippedDates", backT?.skippedDates, ["2026-03-09T10:30:00"]);
  // C3 多个 + 含 Z 后缀存法
  const multi: CalendarEvent = { id: "exd-m@x", title: "多跳过", startsAt: "2026-03-02T10:30:00", isAllDay: false, repeats: { rule: "FREQ=DAILY" }, skippedDates: ["2026-03-03T10:30:00", "2026-03-05T10:30:00Z"] };
  const backM = parseIcsToEvents(buildIcs([multi]))[0];
  eq("C3 多 EXDATE 解析", backM?.skippedDates, ["2026-03-03T10:30:00", "2026-03-05T10:30:00"]);
  // C4 展开时排除生效
  const from = new Date(2026, 2, 1), to = new Date(2026, 2, 20);
  const occT = expandOccurrences([td], from, to).map(o => o.start);
  ok("C4a 定时:3/9 实例被排除", !occT.some(s => s.startsWith("2026-03-09")), JSON.stringify(occT));
  ok("C4b 定时:3/16 实例保留", occT.some(s => s.startsWith("2026-03-16")), JSON.stringify(occT));
  const occA = expandOccurrences([ad], from, to).map(o => o.start);
  ok("C4c 全天:3/9 被排除,3/16 保留", !occA.some(s => s.startsWith("2026-03-09")) && occA.some(s => s.startsWith("2026-03-16")), JSON.stringify(occA));
  const occM = expandOccurrences([multi], from, to).map(o => o.start);
  ok("C4d Z 后缀 skip 也能排除", !occM.some(s => s.startsWith("2026-03-05")) && !occM.some(s => s.startsWith("2026-03-03")) && occM.some(s => s.startsWith("2026-03-04")), JSON.stringify(occM));
  // C5 远端 ICS(带 Z 的 UTC EXDATE)→ 解析
  const remoteIcs = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:remote-exd", "DTSTART:20260302T023000Z", "DTEND:20260302T033000Z", "RRULE:FREQ=DAILY", "EXDATE:20260303T023000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const backR = parseIcsToEvents(remoteIcs)[0];
  console.log(`  [info] 远端 UTC RRULE 事件 startsAt=${backR?.startsAt} skippedDates=${JSON.stringify(backR?.skippedDates)}`);
}

// ═══════════════ D. 跨时区(机器时区 Asia/Shanghai UTC+8)═══════════════
console.log("\n=== D. 跨时区事件解析(期望换算到 UTC+8 本地墙钟)===");
{
  const wrap = (inner: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...inner.split("\n"), "END:VCALENDAR"].join("\r\n");
  const shanghaiVtz = ["BEGIN:VTIMEZONE", "TZID:Asia/Shanghai", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0800", "TZOFFSETTO:+0800", "TZNAME:CST", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");
  const nyVtz = ["BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD", "DTSTART:19701101T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "END:STANDARD", "BEGIN:DAYLIGHT", "DTSTART:19700308T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "END:DAYLIGHT", "END:VTIMEZONE"].join("\r\n");
  // D1 UTC
  const utc = parseIcsToEvents(wrap("BEGIN:VEVENT\nUID:tz-utc\nDTSTART:20260302T020000Z\nDTEND:20260302T030000Z\nSUMMARY:UTC 事件\nEND:VEVENT"))[0];
  console.log(`  [info] UTC 02:00Z → got startsAt=${utc?.startsAt}`);
  eq("D1 UTC 02:00Z → 10:00 (+8)", utc?.startsAt, "2026-03-02T10:00:00");
  // D2 TZID=Asia/Shanghai
  const sh = parseIcsToEvents(wrap(shanghaiVtz + "\r\nBEGIN:VEVENT\nUID:tz-sh\nDTSTART;TZID=Asia/Shanghai:20260302T100000\nDTEND;TZID=Asia/Shanghai:20260302T110000\nSUMMARY:上海事件\nEND:VEVENT"))[0];
  eq("D2 TZID=Asia/Shanghai 10:00 → 10:00", sh?.startsAt, "2026-03-02T10:00:00");
  // D3 TZID=America/New_York(3月2日 EST=UTC-5)
  const ny = parseIcsToEvents(wrap(nyVtz + "\r\nBEGIN:VEVENT\nUID:tz-ny\nDTSTART;TZID=America/New_York:20260302T100000\nDTEND;TZID=America/New_York:20260302T110000\nSUMMARY:纽约事件\nEND:VEVENT"))[0];
  console.log(`  [info] 纽约 10:00 (EST) → got startsAt=${ny?.startsAt}(期望上海 23:00)`);
  eq("D3 TZID=America/New_York 10:00 → 23:00 (+8)", ny?.startsAt, "2026-03-02T23:00:00");
  // D4 浮动时间
  const fl = parseIcsToEvents(wrap("BEGIN:VEVENT\nUID:tz-fl\nDTSTART:20260302T100000\nDTEND:20260302T110000\nSUMMARY:浮动\nEND:VEVENT"))[0];
  eq("D4 浮动 10:00 → 10:00", fl?.startsAt, "2026-03-02T10:00:00");
  // D5 UTC 跨日
  const cross = parseIcsToEvents(wrap("BEGIN:VEVENT\nUID:tz-cross\nDTSTART:20260302T180000Z\nDTEND:20260302T190000Z\nSUMMARY:跨日\nEND:VEVENT"))[0];
  eq("D5 UTC 18:00Z → 次日 02:00 (+8)", cross?.startsAt, "2026-03-03T02:00:00");
  // D6 未知 TZID(无 VTIMEZONE)
  const unk = parseIcsToEvents(wrap("BEGIN:VEVENT\nUID:tz-unk\nDTSTART;TZID=Asia/Shanghai:20260302T100000\nSUMMARY:未知TZID\nEND:VEVENT"))[0];
  eq("D6 无 VTIMEZONE 的 TZID 保持墙钟", unk?.startsAt, "2026-03-02T10:00:00");
}

// ═══════════════ E. serializeRawBlock 手写保真 ═══════════════
console.log("\n=== E. serializeRawBlock 对手写内容的保真 ===");
{
  const raw = [
    "## 09:00–10:00 手写 - 三种 – 连字符 — 都在",
    "- id:: keep@x",
    "- starts:: 2026-03-02T09:00:00",
    "- ends:: 2026-03-02T10:00:00",
    "- allday:: false",
    "- custom_ext:: v1 扩展 保留\\字面",
    "- another_unknown:: 值",
    "",
    "正文第一行:反斜杠 C:\\Users\\test\\notes",
    "  保留缩进",
    "- 这行像字段但键含中文:: 应留正文",
    "",
    "",
    "空行后还有内容",
    "",
  ].join("\n");
  const p1 = parseMonthlyNote(raw);
  const again = serializeMonthlyNote("", p1.blocks.map(serializeRawBlock));
  const p2 = parseMonthlyNote(again);
  const b1 = p1.blocks[0], b2 = p2.blocks[0];
  eq("E1a heading 一致(含三种连字符)", b2?.heading, b1?.heading);
  eq("E1b 字段键集合一致", Object.keys(b2?.fields ?? {}).sort(), Object.keys(b1?.fields ?? {}).sort());
  eq("E1c 字段值一致", b2?.fields, b1?.fields);
  eq("E1d 正文一致(含反斜杠)", b2?.prose, b1?.prose);
  ok("E1e 往返幂等(两次输出一致)", serializeMonthlyNote("", p2.blocks.map(serializeRawBlock)) === again);
  // 三种连字符的标题前缀剥离(blockToEvent 标题还原)
  for (const dash of ["-", "–", "—"]) {
    const t = serializeBlock({ id: `h-${dash}@x`, title: "会议主题", startsAt: "2026-03-02T09:00:00", endsAt: "2026-03-02T10:00:00", isAllDay: false });
    const ev = blockToEvent(parseMonthlyNote(t).blocks[0]);
    // serializeBlock 输出用 en-dash;这里验证解析端对三种前缀的剥离:
    const manual = `## 09:00${dash}10:00 会议主题\n- id:: h@x\n- starts:: 2026-03-02T09:00:00\n- allday:: false`;
    const ev2 = blockToEvent(parseMonthlyNote(manual).blocks[0]);
    eq(`E2 标题剥离(${JSON.stringify(dash)} 前缀)`, ev2?.title, "会议主题");
    void ev; void t;
  }
  // E3 重复字段行的保真
  const dup = "## 手写重复字段\n- note:: a\n- note:: b\n\n正文";
  const dupAgain = serializeRawBlock(parseMonthlyNote(dup).blocks[0]);
  console.log(`  [info] 重复字段行重写输出:\n${dupAgain.split("\n").map(l => "    | " + l).join("\n")}`);
  // 已知限制:字段模型是 Map,同名字段重复行取末值(主体内容不丢)
  ok("E3 已知限制:重复字段行取末值且内容保留", dupAgain.includes("- note:: b"), dupAgain);
  // E4 全天事件标题恰以时刻开头(前缀剥离歧义)
  const adTitle = noteRoundtrip({ id: "ad-t@x", title: "12:30 提醒事项", startsAt: "2026-03-02", isAllDay: true });
  eq("E4 全天事件标题 '12:30 提醒事项' 不被误剥", adTitle.ev2?.title, "12:30 提醒事项");
  // E5 正文前后空行
  const blankEdge = "## 手写\n\n\n正文开头前有两个空行\n\n\n";
  const blankBack = serializeRawBlock(parseMonthlyNote(blankEdge).blocks[0]);
  console.log(`  [info] 空行边缘重写输出:${JSON.stringify(blankBack)}`);
}

// ═══════════════ F. 同名日历去重 ═══════════════
console.log("\n=== F. 同名日历去重(URL 不同 name 相同)===");
{
  const s1 = sanitize({ calendars: [
    { id: "a", url: "https://caldav.icloud.com/123456/calendars/work/", name: "工作", category: "上班", enabled: true },
    { id: "b", url: "https://caldav.icloud.com.cn/123456/calendars/work/", name: "工作", category: "上班", enabled: true },
  ]});
  eq("F1a 同名去重后数量", s1.calendars.length, 1);
  eq("F1b 保留最后一条(URL 为 .com.cn)", s1.calendars[0]?.url, "https://caldav.icloud.com.cn/123456/calendars/work/");
  eq("F1c 保留最后一条的 id", s1.calendars[0]?.id, "b");
  const s2 = sanitize({ calendars: [
    { id: "a", url: "https://x/1", name: "不同1", category: "", enabled: true },
    { id: "b", url: "https://x/2", name: "不同2", category: "", enabled: true },
  ]});
  eq("F2 不同名两条都保留", s2.calendars.length, 2);
  const s3 = sanitize({ calendars: [
    { id: "a", url: "https://x/1", name: "有名字", category: "", enabled: true },
    { id: "b", url: "https://x/2", name: "", category: "", enabled: true },
  ]});
  eq("F3 无名日历不被误去重", s3.calendars.length, 2);
  const s4 = sanitize({ calendars: [
    { id: "b", url: "https://x/2", name: "工作", category: "", enabled: true },
    { id: "n", url: "https://x/3", name: "", category: "", enabled: true },
    { id: "a", url: "https://x/1", name: "工作", category: "", enabled: true },
  ]});
  eq("F4 去重后保持原相对顺序(有名在前)", s4.calendars.map(c => c.id), ["a", "n"]);
}

// ═══════════════ G. 字段复活(清空不生效)═══════════════
console.log("\n=== G. 已有块上清空字段(place/remind/url 等是否复活)===");
{
  const full: CalendarEvent = { id: "g@x", title: "字段复活", startsAt: "2026-03-02T10:00:00", endsAt: "2026-03-02T11:00:00", isAllDay: false, place: "老地点", category: "老分类", url: "https://old.example", reminderMinutes: [15], organizer: "张三 <z@x.com>" };
  const oldBlock = parseMonthlyNote(serializeBlock(full)).blocks[0];
  const cleared: CalendarEvent = { id: "g@x", title: "字段复活", startsAt: "2026-03-02T10:00:00", endsAt: "2026-03-02T11:00:00", isAllDay: false }; // 全部清空
  const rewrited = serializeBlock(cleared, oldBlock);
  console.log("  重写输出:\n" + rewrited.split("\n").map(l => "    | " + l).join("\n"));
  const back = blockToEvent(parseMonthlyNote(rewrited).blocks[0]);
  eq("G1 清空 place 后不应还原出 place", back?.place, undefined);
  eq("G2 清空 reminderMinutes 后不应还原", back?.reminderMinutes, undefined);
  eq("G3 清空 url 后不应还原", back?.url, undefined);
  // G4 v1 未知键透传(预期行为)
  const legacyBlock = parseMonthlyNote("## v1\n- id:: v1@x\n- starts:: 2026-03-02T10:00:00\n- allday:: false\n- source:: caldav\n- seq:: 7\n\n正文").blocks[0];
  const v1Out = serializeBlock({ id: "v1@x", title: "v1", startsAt: "2026-03-02T10:00:00", isAllDay: false }, legacyBlock);
  ok("G4 v1 扩展键(source/seq)透传保留", v1Out.includes("- source:: caldav") && v1Out.includes("- seq:: 7"), v1Out);
  ok("G5 v1 同步元数据(etag/href)不透传", !v1Out.includes("etag::") && !v1Out.includes("href::"), v1Out);
}

// ═══════════════ H. 端到端管线(ICS → 事件 → writeMonth → loadAll)═══════════════
console.log("\n=== H. 端到端:远端 ICS → parseIcsToEvents → writeMonth → loadAll 读回 ===");
class MemIO implements KeyValueFileIO {
  files = new Map<string, string>();
  async readText(p: string) { return this.files.get(p) ?? null; }
  async writeText(p: string, c: string) { this.files.set(p, c); }
  async remove(p: string) { this.files.delete(p); }
  async listFiles(dir: string) { return [...this.files.keys()].filter((p) => p.startsWith(dir + "/")); }
  async ensureDir(_d: string) {}
}
{
  const remoteIcs = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    // 全天
    "BEGIN:VEVENT", "UID:allday-1", "SUMMARY:全天出行", "DTSTART;VALUE=DATE:20260302", "DTEND;VALUE=DATE:20260303",
    "LOCATION:京郊", "DESCRIPTION:第一行\\n第二行\\\\反斜杠", "CATEGORIES:旅行", "STATUS:CONFIRMED",
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "END:VALARM", "END:VEVENT",
    // 取消
    "BEGIN:VEVENT", "UID:cancel-1", "SUMMARY:已取消会议", "DTSTART:20260305T140000", "DTEND:20260305T150000", "STATUS:CANCELLED", "END:VEVENT",
    // 重复 + EXDATE + 提醒
    "BEGIN:VEVENT", "UID:recur-1", "SUMMARY:每周站会", "DTSTART:20260302T093000", "DTEND:20260302T100000",
    "RRULE:FREQ=WEEKLY", "EXDATE:20260309T093000", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT10M", "END:VALARM", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const parsed = parseIcsToEvents(remoteIcs);
  eq("H0a 解析出 3 个事件", parsed.length, 3);
  const io = new MemIO();
  const store = new MonthlyNoteStore(io, "Agenda");
  await store.writeMonth("2026-03", parsed);
  const fileText = await io.readText("Agenda/2026-03.md") ?? "";
  console.log("  落盘笔记:\n" + fileText.split("\n").map(l => "    | " + l).join("\n"));
  const loaded = await store.loadAll();
  eq("H1 读回数量", loaded.events.length, 3);
  const byId = new Map(loaded.events.map(e => [e.id, e]));
  const ad = byId.get("allday-1"), cc = byId.get("cancel-1"), rc = byId.get("recur-1");
  // 全天事件完整性
  eq("H2a 全天 title", ad?.title, "全天出行");
  eq("H2b 全天 startsAt", ad?.startsAt, "2026-03-02");
  eq("H2c 全天 endsAt", ad?.endsAt, "2026-03-03");
  eq("H2d 全天 isAllDay", ad?.isAllDay, true);
  eq("H2e 全天 place", ad?.place, "京郊");
  eq("H2f 全天 notes", ad?.notes, "第一行\n第二行\\反斜杠");
  eq("H2g 全天 category", ad?.category, "旅行");
  eq("H2h 全天 status", ad?.status, "confirmed");
  eq("H2i 全天 reminderMinutes", ad?.reminderMinutes, [15]);
  // 取消事件
  eq("H3a 取消 status", cc?.status, "cancelled");
  eq("H3b 取消 title", cc?.title, "已取消会议");
  eq("H3c 取消 startsAt", cc?.startsAt, "2026-03-05T14:00:00");
  // 重复事件
  eq("H4a 重复 repeats.rule", rc?.repeats?.rule, "FREQ=WEEKLY");
  eq("H4b 重复 skippedDates", rc?.skippedDates, ["2026-03-09T09:30:00"]);
  eq("H4c 重复 reminderMinutes", rc?.reminderMinutes, [10]);
  eq("H4d 重复 startsAt", rc?.startsAt, "2026-03-02T09:30:00");
  // H5 编辑清空 place → 重写 → 是否复活
  if (ad) {
    const edited: CalendarEvent = { ...ad, place: undefined };
    await store.writeMonth("2026-03", [edited, cc!, rc!]);
    const reloaded = await store.loadAll();
    const ad2 = reloaded.events.find(e => e.id === "allday-1");
    eq("H5 清空 place 再写→读,place 应消失", ad2?.place, undefined);
  }
  // H6 跨月移动(按契约传【库内全量】):事件移到 4 月
  if (cc) {
    const moved: CalendarEvent = { ...cc, startsAt: "2026-04-05T14:00:00", endsAt: "2026-04-05T15:00:00" };
    await store.writeMonth("2026-04", [moved]);
    await store.writeMonth("2026-03", [ad!, rc!, moved]); // 全量语义
    const reloaded = await store.loadAll();
    ok("H6a 全量语义:4 月有新块", reloaded.events.some(e => e.id === "cancel-1" && e.startsAt.startsWith("2026-04")));
    ok("H6b 全量语义:3 月旧块已清除", !reloaded.events.some(e => e.id === "cancel-1" && e.startsAt.startsWith("2026-03")));
  }
  // H7 手写块在 writeMonth 中保留
  const io2 = new MemIO();
  await io2.writeText("Agenda/2026-03.md", "## 2026年3月\n\n## 手写备忘(无字段)\n随便写的段落\n第二段\n");
  const store2 = new MonthlyNoteStore(io2, "Agenda");
  await store2.writeMonth("2026-03", [{ id: "fresh@x", title: "新事件", startsAt: "2026-03-08T08:00:00", isAllDay: false }]);
  const txt2 = await io2.readText("Agenda/2026-03.md") ?? "";
  ok("H7 手写块原样保留", txt2.includes("## 手写备忘(无字段)") && txt2.includes("随便写的段落"), txt2);

  // H8:main.ts writeAll 已改为"库内全量"传参(契约修复),此处模拟修复后调用:
  // 订阅事件跨月移动 3月 → 4月,months 并集重写,每月传全量
  {
    const io3 = new MemIO();
    const s3 = new MonthlyNoteStore(io3, "Agenda");
    const orig: CalendarEvent = { id: "sub-1@ics", title: "订阅事件", startsAt: "2026-03-10T09:00:00", endsAt: "2026-03-10T10:00:00", isAllDay: false };
    await s3.writeMonth("2026-03", [orig]);
    const moved: CalendarEvent = { ...orig, startsAt: "2026-04-10T09:00:00", endsAt: "2026-04-10T10:00:00" };
    for (const m of ["2026-03", "2026-04"]) {
      await s3.writeMonth(m, [moved], "");
    }
    const file3 = await io3.readText("Agenda/2026-03.md") ?? "";
    ok("H8a 旧月残留块已删除(期望失败=存在残留)", !file3.includes("sub-1@ics"), file3);
    const reloaded = await s3.loadAll();
    const sub = reloaded.events.find(e => e.id === "sub-1@ics");
    console.log(`  [info] writeAll 过滤式调用后 loadAll 读回 startsAt=${sub?.startsAt}(移动后期望 2026-04-10)`);
    ok("H8b 移动未被旧块回滚", sub?.startsAt === "2026-04-10T09:00:00", `got ${sub?.startsAt}`);
  }
}

function monthOf(startsAt: string): string {
  return startsAt.slice(0, 7);
}

// ═══════════════ I. v1 遗留字段 + 杂项 ═══════════════
console.log("\n=== I. v1 遗留字段读回 + 指纹 ===");
{
  const legacy = "## 09:00 老数据\n- uid:: old@x\n- start:: 2026-03-02T09:00:00\n- end:: 2026-03-02T10:00:00\n- all_day:: false\n- location:: 老地点\n- rrule:: FREQ=DAILY\n- exdates:: 2026-03-03T09:00:00\n- reminder:: 5\n- etag:: \"abc\"\n- href:: /cal/old.ics";
  const blk = parseMonthlyNote(legacy).blocks[0];
  const ev = blockToEvent(blk);
  eq("I1a v1 uid→id", ev?.id, "old@x");
  eq("I1b v1 location→place", ev?.place, "老地点");
  eq("I1c v1 rrule→repeats", ev?.repeats?.rule, "FREQ=DAILY");
  eq("I1d v1 exdates→skippedDates", ev?.skippedDates, ["2026-03-03T09:00:00"]);
  eq("I1e v1 reminder→reminderMinutes", ev?.reminderMinutes, [5]);
  const r2 = noteRoundtrip(ev!);
  eq("I2 v1 读回后再按 v2 往返", r2.ev2, { ...ev, notes: undefined });
  // 指纹稳定性
  const fp1 = await contentFingerprint({ id: "f@x", title: "t", startsAt: "2026-03-02T10:00:00", isAllDay: false });
  const fp2 = await contentFingerprint({ id: "f@x", title: "t", startsAt: "2026-03-02T10:00:00", isAllDay: false });
  const fp3 = await contentFingerprint({ id: "f@x", title: "t", startsAt: "2026-03-02T10:00:00", isAllDay: false, status: "cancelled" });
  eq("I3a 指纹稳定", fp1, fp2);
  ok("I3b status 进入指纹", fp1 !== fp3);
  // I4 serializeBlock 冗余赋值检查(status 两次写入)
  const src = (await import("node:fs")).readFileSync(new URL("../src/data/note-format.ts", import.meta.url), "utf8");
  const statusWrites = [...src.matchAll(/fields\["status"\] = ev\.status/g)].length;
  console.log(`  [info] note-format.ts 中 fields["status"] = ev.status 出现 ${statusWrites} 次`);
}

// ═══════════════ J. occurrences.ts 展开健壮性 ═══════════════
console.log("\n=== J. 重复事件展开(老起点钳制/全天重复/边界)===");
{
  const from = new Date(2026, 2, 1), to = new Date(2026, 3, 1);
  // J1 老起点全天重复(2020 年起,触发 400 天钳制路径)
  const oldAd: CalendarEvent = { id: "old-ad@x", title: "老全天重复", startsAt: "2020-01-01", isAllDay: true, repeats: { rule: "FREQ=DAILY" } };
  const occJ1 = expandOccurrences([oldAd], from, to).map(o => o.start);
  ok("J1a 老全天 DAILY 在窗口内每天出现", occJ1.length === 31 && occJ1[0] === "2026-03-01" && occJ1[30] === "2026-03-31", `n=${occJ1.length} first=${occJ1[0]} last=${occJ1[30]}`);
  const oldT: CalendarEvent = { id: "old-t@x", title: "老定时重复", startsAt: "2020-01-01T08:30:00", endsAt: "2020-01-01T09:00:00", isAllDay: false, repeats: { rule: "FREQ=WEEKLY" } };
  const occJ2 = expandOccurrences([oldT], from, to).map(o => o.start);
  ok("J1b 老定时 WEEKLY 保持周一 08:30", occJ2.length === 4 && occJ2.every(s => s.startsWith("2026-0") && s.endsWith("T08:30:00")), JSON.stringify(occJ2));
  const oldMo: CalendarEvent = { id: "old-mo@x", title: "老月重复", startsAt: "2020-01-15T20:00:00", isAllDay: false, repeats: { rule: "FREQ=MONTHLY" } };
  const occJ3 = expandOccurrences([oldMo], from, to).map(o => o.start);
  ok("J1c 老定时 MONTHLY 3/15 20:00 出现", occJ3.some(s => s === "2026-03-15T20:00:00"), JSON.stringify(occJ3));
  // J2 全天多日事件展开
  const multi: CalendarEvent = { id: "multi@x", title: "三天行程", startsAt: "2026-03-10", endsAt: "2026-03-13", isAllDay: true };
  const occJ4 = expandOccurrences([multi], from, to).map(o => [o.start, o.end]);
  eq("J2 全天多日拆成 3 个单日", occJ4, [["2026-03-10", "2026-03-11"], ["2026-03-11", "2026-03-12"], ["2026-03-12", "2026-03-13"]]);
  // J3 跨午夜定时事件
  const overnight: CalendarEvent = { id: "on@x", title: "跨午夜", startsAt: "2026-03-10T23:00:00", endsAt: "2026-03-11T01:00:00", isAllDay: false };
  const occJ5 = expandOccurrences([overnight], from, to).map(o => [o.start, o.end]);
  eq("J3 跨午夜拆两天", occJ5, [["2026-03-10T23:00:00", "2026-03-11T00:00:00"], ["2026-03-11T00:00:00", "2026-03-11T01:00:00"]]);
  // J4 BYDAY 规则 + 老起点(BYDAY 显式指定星期,不受钳制影响)
  const byday: CalendarEvent = { id: "bd@x", title: "每周一三五", startsAt: "2024-01-01T07:00:00", isAllDay: false, repeats: { rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" } };
  const occJ6 = expandOccurrences([byday], from, to).map(o => o.start);
  ok("J4 BYDAY 老起点:窗口内周一三五共 13 天", occJ6.length === 13 && occJ6[0] === "2026-03-02T07:00:00", JSON.stringify(occJ6));
  // J5 全天 WEEKLY + 老起点(同为钳制受害者)
  const adWeekly: CalendarEvent = { id: "adw@x", title: "每周三全天", startsAt: "2026-08-05", isAllDay: true, repeats: { rule: "FREQ=WEEKLY" } };
  const occJ7 = expandOccurrences([adWeekly], new Date(2026, 9, 5), new Date(2026, 9, 12)).map(o => o.start);
  ok("J5 全天 WEEKLY(周三)在 10/5-10/12 窗口应出现在 10/7", occJ7.includes("2026-10-07"), JSON.stringify(occJ7));
  // J6 YEARLY 生日(5/20)在 10 月窗口不应出现
  const yearly: CalendarEvent = { id: "y@x", title: "生日", startsAt: "2020-05-20T00:00:00", isAllDay: false, repeats: { rule: "FREQ=YEARLY" } };
  const occJ8 = expandOccurrences([yearly], new Date(2026, 9, 1), new Date(2026, 10, 1)).map(o => o.start);
  ok("J6 YEARLY(5/20)在 10 月窗口不应出现", occJ8.length === 0, JSON.stringify(occJ8));
}

console.log(`\n════ 结果:PASS=${pass} FAIL=${fails.length} ════`);
if (fails.length) { console.log("\n失败明细:"); fails.forEach((f, i) => console.log(`${i + 1}. ${f}`)); }
process.exit(fails.length ? 1 : 0);
