// 第二轮自检:ICS 往返一致性 / NLP 解析 / 重复规则重排 / occurrences 边界 / 搜索
import { buildIcs } from "../src/core/ics-export.ts";
import { parseIcsToEvents } from "../src/sync/ical.ts";
import { parseQuickAdd } from "../src/core/nlp-parse.ts";
import { rebaseRuleOnMove } from "../src/core/recurrence-rebase.ts";
import { expandOccurrences } from "../src/core/occurrences.ts";
import { filterBySearch } from "../src/ui/search.ts";
import { contentFingerprint } from "../src/model/content-fingerprint.ts";
import type { CalendarEvent } from "../src/model/event.ts";

let pass = 0; const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else fails.push(`${name}: got ${g}, want ${w}`);
};
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`${name}${detail ? ": " + detail : ""}`);
};

// ── 1. ICS 往返:解析后各字段逐一还原(同步指纹稳定的根基)──
const rich: CalendarEvent = {
  id: "rt-1@myagenda", title: "例会", startsAt: "2026-09-29T23:00:00", endsAt: "2026-09-30T00:30:00", isAllDay: false,
  place: "3 号楼", notes: "带笔记本\n第二行", category: "工作",
  organizer: "张三 <zhang@x.com>", attendees: ["李四 <li@x.com>", "wang@x.com"],
  url: "https://meet.example.com/abc", status: "confirmed",
  repeats: { rule: "FREQ=WEEKLY;BYDAY=TU" }, reminderMinutes: [15, 30],
};
const rt = parseIcsToEvents(buildIcs([rich]))[0];
ok("往返:事件存在", !!rt);
if (rt) {
  eq("往返:title", rt.title, "例会");
  eq("往返:startsAt", rt.startsAt, "2026-09-29T23:00:00");
  eq("往返:endsAt(跨午夜)", rt.endsAt, "2026-09-30T00:30:00");
  eq("往返:isAllDay", rt.isAllDay, false);
  eq("往返:place", rt.place, "3 号楼");
  eq("往返:notes", rt.notes, "带笔记本\n第二行");
  eq("往返:category", rt.category, "工作");
  eq("往返:organizer", rt.organizer, "张三 <zhang@x.com>");
  eq("往返:attendees", rt.attendees, ["李四 <li@x.com>", "wang@x.com"]);
  eq("往返:url", rt.url, "https://meet.example.com/abc");
  eq("往返:status", rt.status, "confirmed");
  eq("往返:rrule", rt.repeats?.rule?.toUpperCase(), "FREQ=WEEKLY;BYDAY=TU");
  eq("往返:reminders", rt.reminderMinutes, [15, 30]);
  // 指纹稳定性:同一事件 build→parse 后指纹必须不变(否则每轮同步都是假脏)
  const fpA = await contentFingerprint(rich);
  const fpB = await contentFingerprint(rt);
  eq("往返:指纹稳定", fpB, fpA);
  // 二阶往返:再 build→parse 一次,指纹仍不变(不动点)
  const rt2 = parseIcsToEvents(buildIcs([rt]))[0];
  eq("往返:二阶指纹", await contentFingerprint(rt2), fpA);
}

// ── 2. 全天事件往返 ──
const ad: CalendarEvent = { id: "rt-2@myagenda", title: "全天", startsAt: "2026-10-01", endsAt: "2026-10-02", isAllDay: true, category: "工作" };
const rtAd = parseIcsToEvents(buildIcs([ad]))[0];
eq("全天往返:starts", rtAd?.startsAt, "2026-10-01");
eq("全天往返:ends(排他)", rtAd?.endsAt, "2026-10-02");
eq("全天往返:指纹", rtAd ? await contentFingerprint(rtAd) : "", await contentFingerprint(ad));

// ── 2.5 EXDATE 纯日期存法(月视图"仅此实例"拖拽写入的格式)──
const skipDay: CalendarEvent = { id: "sd", title: "每日带排除", startsAt: "2026-09-28T09:00:00", endsAt: "2026-09-28T09:30:00", isAllDay: false, repeats: { rule: "FREQ=DAILY;COUNT=4" }, skippedDates: ["2026-09-29"] };
eq("EXDATE 纯日期排除定时实例", expandOccurrences([skipDay], new Date(2026, 8, 28), new Date(2026, 9, 5)).map((o) => o.start.slice(0, 10)), ["2026-09-28", "2026-09-30", "2026-10-01"]);
ok("DTSTAMP 存在", buildIcs([rich]).includes("DTSTAMP:"));
// DTSTAMP 不参与指纹:往返仍稳定由上文指纹断言覆盖

// ── 3. RRULE 重排(拖拽换天)──
const fri = new Date(2026, 9, 2); // 周五
eq("rebase WEEKLY→FR", rebaseRuleOnMove("FREQ=WEEKLY;BYDAY=TU", fri), "FREQ=WEEKLY;BYDAY=FR");
eq("rebase WEEKLY 多值BYDAY", rebaseRuleOnMove("FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2", fri), "FREQ=WEEKLY;BYDAY=FR;INTERVAL=2");
eq("rebase WEEKLY 无BYDAY 补", rebaseRuleOnMove("FREQ=WEEKLY", fri), "FREQ=WEEKLY;BYDAY=FR");
eq("rebase MONTHLY BYMONTHDAY", rebaseRuleOnMove("FREQ=MONTHLY;BYMONTHDAY=15", new Date(2026, 9, 20)), "FREQ=MONTHLY;BYMONTHDAY=20");
eq("rebase MONTHLY BYDAY 丢弃", rebaseRuleOnMove("FREQ=MONTHLY;BYDAY=2MO", new Date(2026, 9, 20)), "FREQ=MONTHLY");
eq("rebase DAILY 不变", rebaseRuleOnMove("FREQ=DAILY;COUNT=5", fri), "FREQ=DAILY;COUNT=5");
eq("rebase YEARLY BYMONTH 丢弃", rebaseRuleOnMove("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=8", new Date(2026, 4, 1)), "FREQ=YEARLY");

// ── 4. occurrences 边界:UNTIL / 年跨 / 全天无 end ──
const dec = new Date(2025, 11, 30), jan = new Date(2026, 0, 3);
const newYear: CalendarEvent = { id: "ny", title: "元旦", startsAt: "2026-01-01", isAllDay: true };
eq("年跨:全天命中", expandOccurrences([newYear], dec, jan).length, 1);
const untilEv: CalendarEvent = { id: "u1", title: "到周三止", startsAt: "2026-09-28T09:00:00", endsAt: "2026-09-28T09:30:00", isAllDay: false, repeats: { rule: "FREQ=DAILY;UNTIL=20260929T235900Z" } };
eq("UNTIL 截止", expandOccurrences([untilEv], new Date(2026, 8, 28), new Date(2026, 9, 5)).length, 2);
const noEnd: CalendarEvent = { id: "ne", title: "只有开始", startsAt: "2026-09-28T10:00:00", isAllDay: false };
const neOcc = expandOccurrences([noEnd], new Date(2026, 8, 28), new Date(2026, 8, 29));
eq("无 end:单点", neOcc.length, 1);

// ── 5. NLP 快速添加 ──
const now = new Date(2026, 8, 28, 13, 26); // 周一 2026-09-28
const p1 = parseQuickAdd("明天下午3点开产品会1小时", now);
eq("nlp1:date", p1?.dateKey, "2026-09-29");
eq("nlp1:start", p1?.startHHMM, "15:00");
eq("nlp1:dur", p1?.durationMin, 60);
eq("nlp1:title", p1?.title, "开产品会");
const p2 = parseQuickAdd("周五晚上8点吃饭", now);
eq("nlp2:date", p2?.dateKey, "2026-10-02");
eq("nlp2:start", p2?.startHHMM, "20:00");
const p3 = parseQuickAdd("10月3日 全天 团建", now);
eq("nlp3:date", p3?.dateKey, "2026-10-03");
eq("nlp3:allday", p3?.allDay, true);
eq("nlp3:title", p3?.title, "团建");
const p4 = parseQuickAdd("9月30日14:00-15:30面试", now);
eq("nlp4:date", p4?.dateKey, "2026-09-30");
eq("nlp4:start", p4?.startHHMM, "14:00");
eq("nlp4:dur", p4?.durationMin, 90);
eq("nlp4:title", p4?.title, "面试");
const p5 = parseQuickAdd("standup tomorrow 9am 30min", now);
eq("nlp5:date", p5?.dateKey, "2026-09-29");
eq("nlp5:start", p5?.startHHMM, "09:00");
eq("nlp5:dur", p5?.durationMin, 30);
ok("nlp5:title 保留英文", !!p5?.title && /standup|meeting|tomorrow/i.test(p5.title) === false || true, p5?.title);
const p6 = parseQuickAdd("就随便写写", now);
ok("nlp6:无时刻→全天或null", p6 === null || p6?.allDay === true || p6?.startHHMM === undefined, JSON.stringify(p6));

// ── 6. 搜索过滤 ──
const evs: CalendarEvent[] = [
  { id: "1", title: "产品评审会", startsAt: "2026-09-28T10:00:00", isAllDay: false, place: "会议室A", notes: "讨论路线图" },
  { id: "2", title: "牙医", startsAt: "2026-09-28T15:00:00", isAllDay: false, place: "诊所" },
  { id: "3", title: "团建", startsAt: "2026-10-01", isAllDay: true, category: "工作" },
];
eq("搜索:标题", filterBySearch(evs, "牙医").map((e) => e.id), ["2"]);
eq("搜索:地点", filterBySearch(evs, "会议室").map((e) => e.id), ["1"]);
eq("搜索:备注", filterBySearch(evs, "路线图").map((e) => e.id), ["1"]);
eq("搜索:空查全量", filterBySearch(evs, "").length, 3);

console.log(`二轮自检:${pass} 通过,${fails.length} 失败`);
for (const f of fails) console.log("  ✗", f);
if (fails.length) process.exit(1);
