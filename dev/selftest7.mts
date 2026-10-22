// 重复事件拖拽规划:后续实例拖拽绝不动锚点(用户报告的核心 bug)
import { planRecurringMove } from "../src/core/recurrence-move.ts";
import { expandOccurrences } from "../src/core/occurrences.ts";
import type { CalendarEvent } from "../src/model/event.ts";

let pass = 0; const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else fails.push(`${name}: got ${g}, want ${w}`);
};

// 9月30日(周三)开始每周重复 10:00-11:00
const master: CalendarEvent = {
  id: "m1@myagenda", title: "周会", startsAt: "2026-09-30T10:00:00", endsAt: "2026-09-30T11:00:00",
  isAllDay: false, repeats: { rule: "FREQ=WEEKLY" },
};
const from = new Date(2026, 8, 30), to = new Date(2026, 9, 21);
const days = (evs: CalendarEvent[]) => expandOccurrences(evs, from, to).map((o) => o.start.slice(0, 10) + " " + o.start.slice(11, 16));

// 场景:下一周(10月7日实例)拖到 15:00-16:00 → 仅该实例移动,30号必须还在
const plan1 = planRecurringMove(master, "2026-10-07T10:00:00", "2026-10-07T15:00:00", "2026-10-07T16:00:00", "single");
eq("单实例:两个事件(主+例外)", plan1.length, 2);
eq("单实例:锚点不动", plan1[0]?.startsAt, "2026-09-30T10:00:00");
eq("单实例:EXDATE 10-07", plan1[0]?.skippedDates, ["2026-10-07"]);
eq("单实例:例外在 10-07 15:00", plan1[1]?.startsAt, "2026-10-07T15:00:00");
const merged1 = [plan1[0], plan1[1]];
eq("拖后:30号 10:00 仍在", days(merged1).includes("2026-09-30 10:00"), true);
eq("拖后:10-07 变 15:00", days(merged1).includes("2026-10-07 15:00"), true);
eq("拖后:10-07 10:00 消失", days(merged1).includes("2026-10-07 10:00"), false);
eq("拖后:10-14 仍在", days(merged1).includes("2026-10-14 10:00"), true);

// 再拖回去(10-07 例外拖回 10:00)→ 30号依然在,10-07 回到 10:00
const master2 = plan1[0];
const plan2 = planRecurringMove(master2, "2026-10-07T15:00:00", "2026-10-07T10:00:00", "2026-10-07T11:00:00", "single");
// 例外事件的拖拽:例外没有 repeats → 走普通路径;这里模拟用户把例外拖回原时刻
const overrideMoved = { ...plan2[1], startsAt: "2026-10-07T10:00:00", endsAt: "2026-10-07T11:00:00" };
const merged2 = [plan2[0], overrideMoved];
eq("拖回:30号 10:00 仍在", days(merged2).includes("2026-09-30 10:00"), true);
eq("拖回:10-07 回到 10:00", days(merged2).includes("2026-10-07 10:00"), true);

// series pick:整体迁移(30号消失是系列语义,由用户明确选择)
const plan3 = planRecurringMove(master, "2026-10-07T10:00:00", "2026-10-08T09:00:00", "2026-10-08T10:00:00", "series");
eq("series:锚点迁至 10-08 09:00", plan3[0]?.startsAt, "2026-10-08T09:00:00");
eq("series:BYDAY 重写为周四", plan3[0]?.repeats?.rule.includes("TH"), true);

// 锚点实例同日改时间 → series pick = 只改系列时刻,30号仍是锚点
const plan4 = planRecurringMove(master, "2026-09-30T10:00:00", "2026-09-30T14:00:00", "2026-09-30T15:00:00", "series");
eq("锚点改时:30号 14:00", plan4[0]?.startsAt, "2026-09-30T14:00:00");
eq("锚点改时:30号日期不变", plan4[0]?.startsAt.slice(0, 10), "2026-09-30");
// 锚点实例同日改时间 → single pick = 30号 10:00 排除 + 14:00 例外
const plan5 = planRecurringMove(master, "2026-09-30T10:00:00", "2026-09-30T14:00:00", "2026-09-30T15:00:00", "single");
const merged5 = [plan5[0], plan5[1]];
eq("锚点 single:14:00 例外在", days(merged5).includes("2026-09-30 14:00"), true);
eq("锚点 single:10:00 排除", days(merged5).includes("2026-09-30 10:00"), false);
eq("锚点 single:10-07 仍在", days(merged5).includes("2026-10-07 10:00"), true);

console.log(`重复拖拽单测:${pass} 通过,${fails.length} 失败`);
for (const f of fails) console.log("  ✗", f);
if (fails.length) process.exit(1);
