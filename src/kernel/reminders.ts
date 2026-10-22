import type { CalendarEvent } from "../model/event";
import { expandOccurrences, parseLocal } from "../core/occurrences";

export interface DueReminder {
  id: string;
  title: string;
  startIso: string;
  dueIso: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 刚到点的提醒(due ∈ (now-回溯, now]):供轮询触发;过早的绝不提前发,过点太久的不再补发。 */
export function dueReminders(events: CalendarEvent[], now: Date, lookbackMs = 120_000): DueReminder[] {
  const out: DueReminder[] = [];
  const nowMs = now.getTime();
  // 提前量无上限(编辑器任意分钟数),窗口取输入中的最大值,至少 ±2 天
  const maxLeadMin = Math.max(
    2 * 24 * 60,
    ...events.flatMap((ev) => [ev, ...(ev.recurrenceOverrides ?? [])]).flatMap((ev) => ev.reminderMinutes ?? []).map((m) => Math.abs(m)),
  );
  const windowStart = new Date(nowMs - maxLeadMin * 60_000 - lookbackMs);
  const windowEnd = new Date(nowMs + (maxLeadMin / 60) * 3600_000);
  // 使用完整实例起点计算提醒，不能把跨午夜显示切片的 00:00 当成新事件。
  const active = events.filter((ev) => !(ev.repeats?.rule && ev.status?.toLowerCase() === "cancelled"));
  for (const occ of expandOccurrences(active, windowStart, windowEnd, false)) {
    if (occ.event.status?.toLowerCase() === "cancelled") continue;
    const startMs = parseLocal(occ.start).getTime();
    for (const m of occ.event.reminderMinutes ?? []) {
      const dueMs = startMs - m * 60_000;
      if (dueMs <= nowMs && dueMs > nowMs - lookbackMs) {
        out.push({ id: occ.event.id, title: occ.event.title, startIso: occ.start, dueIso: localIso(new Date(dueMs)) });
      }
    }
  }
  return out.sort((a, b) => (a.dueIso < b.dueIso ? -1 : 1));
}
