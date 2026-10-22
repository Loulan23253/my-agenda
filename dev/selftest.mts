// 单元自检:纯逻辑逐项断言,失败即列出
import { normalizeEnd, shiftIsoDays, toLocalIso, parseLocal } from "../src/kernel/dates.ts";
import { buildIcs } from "../src/core/ics-export.ts";
import { expandOccurrences } from "../src/core/occurrences.ts";
import { parseMonthlyNote, serializeBlock } from "../src/data/note-format.ts";
import { EMPTY_JOURNAL, journalPut, journalRemove, journalGet } from "../src/data/journal.ts";
import type { CalendarEvent } from "../src/model/event.ts";

let pass = 0; const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else fails.push(`${name}: got ${g}, want ${w}`);
};

// ── 1. normalizeEnd(跨午夜归一化)──
eq("norm midnight", normalizeEnd("2026-09-29T23:00:00", "2026-09-29T00:00:00"), "2026-09-30T00:00:00");
eq("norm equal→+1h", normalizeEnd("2026-09-29T08:00:00", "2026-09-29T08:00:00"), "2026-09-29T09:00:00");
eq("norm before→+1h", normalizeEnd("2026-09-29T22:00:00", "2026-09-29T21:00:00"), "2026-09-29T23:00:00");
eq("norm valid untouched", normalizeEnd("2026-09-29T10:00:00", "2026-09-29T11:30:00"), "2026-09-29T11:30:00");

// ── 2. shiftIsoDays(月/年跨界)──
eq("shift month", shiftIsoDays("2026-01-31", 1), "2026-02-01");
eq("shift year", shiftIsoDays("2025-12-31", 1), "2026-01-01");
eq("shift leap", shiftIsoDays("2028-02-28", 1), "2028-02-29");

// ── 3. ICS:DTEND 守卫 + 结构 ──
const bad: CalendarEvent = { id: "x@t", title: "跨午夜", startsAt: "2026-09-29T23:00:00", endsAt: "2026-09-29T00:00:00", isAllDay: false };
const ics = buildIcs([bad]);
eq("ics guard DTEND", /DTEND:20260930T000000/.test(ics), true);
eq("ics DTSTART", /DTSTART:20260929T230000/.test(ics), true);
const ad: CalendarEvent = { id: "y@t", title: "全天", startsAt: "2026-10-01", endsAt: "2026-10-01", isAllDay: true };
eq("ics allday +1d", /DTEND;VALUE=DATE:20261002/.test(buildIcs([ad])), true);

// ── 4. occurrences:跨午夜裁剪 / RRULE / EXDATE / 全天多日 ──
const from = new Date(2026, 8, 28), to = new Date(2026, 9, 5);
const crossMid: CalendarEvent = { id: "c1", title: "跨", startsAt: "2026-09-29T23:00:00", endsAt: "2026-09-30T01:00:00", isAllDay: false };
const cOcc = expandOccurrences([crossMid], from, to);
eq("crossmid 2 clips", cOcc.length, 2);
eq("crossmid clip1 end", cOcc[0]?.end, "2026-09-30T00:00:00");
eq("crossmid clip2 start", cOcc[1]?.start, "2026-09-30T00:00:00");
const daily: CalendarEvent = { id: "d1", title: "每日", startsAt: "2026-09-28T09:00:00", endsAt: "2026-09-28T09:30:00", isAllDay: false, repeats: { rule: "FREQ=DAILY;COUNT=5" } };
eq("rrule count", expandOccurrences([daily], from, to).length, 5);
const skip: CalendarEvent = { id: "s1", title: "跳过", startsAt: "2026-09-28T09:00:00", isAllDay: false, repeats: { rule: "FREQ=DAILY;COUNT=3" }, skippedDates: ["2026-09-29T09:00:00"] };
eq("exdate", expandOccurrences([skip], from, to).length, 2);
const multi: CalendarEvent = { id: "m1", title: "多日全天", startsAt: "2026-09-29", endsAt: "2026-10-01", isAllDay: true };
eq("allday span", expandOccurrences([multi], from, to).map((o) => o.start), ["2026-09-29", "2026-09-30"]);

// ── 5. 笔记往返:v2 字段 + v1 遗留字段共存 ──
const noteText = [
  "# 2026-09", "",
  "## 23:00–00:00 测试",
  "- id:: a@myagenda",
  "- starts:: 2026-09-29T23:00:00",
  "- ends:: 2026-09-29T00:00:00",
  "- allday:: false",
  "- category:: 工作",
  "- uid:: legacy@ogenda",
  "- start:: 2026-09-29T18:30:00",
  "", "手写备注内容",
].join("\n");
const parsed = parseMonthlyNote(noteText);
const blocks = parsed.blocks ?? parsed;
const evBack = (blocks as never as { [k: string]: unknown }[])[0];
const b0 = Array.isArray(blocks) ? blocks[0] : Object.values(blocks)[0];
eq("note block id", (b0 as { fields: Record<string, string> }).fields["id"], "a@myagenda");
eq("note keeps prose", /手写备注内容/.test(noteText), true);

// ── 6. 账本操作 ──
const j = JSON.parse(JSON.stringify(EMPTY_JOURNAL)) as { events: Record<string, { state: string }> };
journalPut(j, "e1", { state: "synced", calendarId: "c1", href: "h", etag: "e", pushedFingerprint: "f" } as never);
eq("journal get", journalGet(j, "e1")?.state, "synced");
journalRemove(j, "e1");
eq("journal removed", journalGet(j, "e1"), undefined);

// ── 7. 快速添加跨午夜公式(与 quick-add-modal 同步的换算)──
const rollover = (startHHMM: string, dur: number, dateKey: string) => {
  const [h, m] = startHHMM.split(":").map(Number);
  const total = h * 60 + m + dur;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${shiftIsoDays(dateKey, Math.floor(total / 1440))}T${p2(Math.floor((total % 1440) / 60))}:${p2(total % 60)}:00`;
};
eq("rollover 23:00+60", rollover("23:00", 60, "2026-09-29"), "2026-09-30T00:00:00");
eq("rollover 23:30+90", rollover("23:30", 90, "2026-09-29"), "2026-09-30T01:00:00");
eq("rollover same day", rollover("09:00", 60, "2026-09-29"), "2026-09-29T10:00:00");

console.log(`单测:${pass} 通过,${fails.length} 失败`);
for (const f of fails) console.log("  ✗", f);
if (fails.length) process.exit(1);
