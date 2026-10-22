// 提醒时序单测:到点才发/回溯容忍/过点不补发/提前绝不发/多提醒各自触发/重复事件每日触发
import { dueReminders } from "../src/kernel/reminders.ts";
import type { CalendarEvent } from "../src/model/event.ts";

let pass = 0; const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else fails.push(`${name}: got ${g}, want ${w}`);
};

const ev: CalendarEvent = { id: "a", title: "晨会", startsAt: "2026-09-30T10:00:00", endsAt: "2026-09-30T10:30:00", isAllDay: false, reminderMinutes: [15] };
const at = (h: number, mi: number) => new Date(2026, 8, 30, h, mi, 0);

eq("提前 16 分钟:不发", dueReminders([ev], at(9, 44)).length, 0);
eq("到点(09:45:30):发", dueReminders([ev], at(9, 45, 30)).map((r) => r.dueIso.slice(11, 16)), ["09:45"]);
eq("过点 90 秒:回溯容忍仍发", dueReminders([ev], at(9, 46, 30)).length, 1);
eq("过点 3 分钟:不补发", dueReminders([ev], at(9, 48)).length, 0);
eq("事件开始时(10:00):不重复发", dueReminders([ev], at(10, 0)).length, 0);

const multi: CalendarEvent = { ...ev, reminderMinutes: [30, 15] };
eq("双提醒各自触发", dueReminders([multi], at(9, 45, 30)).map((r) => r.dueIso.slice(11, 16)), ["09:45"]);

const daily: CalendarEvent = { id: "d", title: "每日提醒", startsAt: "2026-09-28T09:00:00", isAllDay: false, repeats: { rule: "FREQ=DAILY" }, reminderMinutes: [10] };
eq("重复事件昨日已过:今天到点再发", dueReminders([daily], at(8, 50, 30)).map((r) => r.dueIso.slice(11, 16)), ["08:50"]);
eq("重复事件明天:不发", dueReminders([daily], at(20, 0)).length, 0);

const allday: CalendarEvent = { id: "b", title: "全天带提醒", startsAt: "2026-09-30", isAllDay: true, reminderMinutes: [60] };
// 全天事件 ICAL.Time 从零点起算:提前 60 分钟 = 前一天 23:00,当天任何时刻都不在回溯窗
eq("全天提醒按零点起算", dueReminders([allday], at(9, 0)).length, 0);

console.log(`提醒单测:${pass} 通过,${fails.length} 失败`);
for (const f of fails) console.log("  ✗", f);
if (fails.length) process.exit(1);
