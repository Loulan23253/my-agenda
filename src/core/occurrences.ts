import ICAL from "ical.js";
import type { CalendarEvent } from "../model/event";

export interface Occurrence {
  event: CalendarEvent;
  start: string;
  end?: string;
}

export function parseLocal(s: string): Date {
  if (s.includes("T")) return new Date(s);
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDateTime(d: Date): string {
  return `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function expandSingle(ev: CalendarEvent, from: Date, to: Date): Occurrence[] {
  const start = parseLocal(ev.startsAt);
  const end = ev.endsAt ? parseLocal(ev.endsAt) : undefined;
  const out: Occurrence[] = [];
  if (ev.isAllDay) {
    if (!end || end.getTime() === startOfDay(start).getTime()) {
      if (start >= from && start < to) out.push({ event: ev, start: ev.startsAt, end: ev.endsAt });
      return out;
    }
    for (let d = startOfDay(start > from ? start : from); d < end; d = addDays(d, 1)) {
      if (d >= to) break;
      if (d >= from) out.push({ event: ev, start: fmtDate(d), end: fmtDate(addDays(d, 1)) });
    }
    return out;
  }
  if (!end) {
    if (start >= from && start < to) out.push({ event: ev, start: ev.startsAt, end: ev.endsAt });
    return out;
  }
  for (let day = startOfDay(start > from ? start : from); day <= startOfDay(end); day = addDays(day, 1)) {
    const dayStart = startOfDay(day);
    const dayEnd = addDays(dayStart, 1);
    if (dayStart >= to) break;
    if (dayEnd <= from) continue;
    const cs = start > dayStart ? start : dayStart;
    const ce = end < dayEnd ? end : dayEnd;
    if (cs < ce) out.push({ event: ev, start: fmtDateTime(cs), end: fmtDateTime(ce) });
  }
  return out;
}

function toIcalTime(iso: string, allDay: boolean): ICAL.Time {
  return allDay ? ICAL.Time.fromDateString(iso) : ICAL.Time.fromDateTimeString(iso);
}

export function expandOccurrences(events: CalendarEvent[], from: Date, to: Date, splitDays = true): Occurrence[] {
  const out: Occurrence[] = [];
  const emit = (event: CalendarEvent, start: string, end?: string) => {
    const startDate = parseLocal(start);
    const endDate = end ? parseLocal(end) : startDate;
    if (startDate >= to || (endDate > startDate ? endDate <= from : startDate < from)) return;
    if (splitDays) {
      out.push(...expandSingle({ ...event, startsAt: start, endsAt: end }, from, to).map((occ) => ({ ...occ, event })));
    } else out.push({ event, start, end });
  };
  for (const ev of events) {
    const overrides = ev.recurrenceOverrides ?? [];
    for (const override of overrides) emit(override, override.startsAt, override.endsAt);
    if (!ev.repeats?.rule) {
      if (!overrides.length) emit(ev, ev.startsAt, ev.endsAt);
      continue;
    }
    // 排除实例:兼容完整时刻与纯日期两种存法(拖拽"仅此实例"写纯日期)
    const excludedFull = new Set((ev.skippedDates ?? []).map((s) => s.replace("Z", "")));
    const excludedDay = new Set([...excludedFull].filter((s) => !s.includes("T")));
    for (const override of overrides) if (override.recurrenceId) excludedFull.add(override.recurrenceId);
    const dtstart = toIcalTime(ev.startsAt, ev.isAllDay);
    const duration = ev.endsAt ? toIcalTime(ev.endsAt, ev.isAllDay).subtractDate(dtstart) : null;
    let iter: ICAL.RecurIterator;
    try {
      iter = ICAL.Recur.fromString(ev.repeats.rule).iterator(dtstart);
    } catch {
      continue;
    }
    let next = iter.next();
    // 迭代预算:DTSTART 距窗口每远一天多 1 次迭代(下限 10000),
    // 保证 28 年前的 DAILY 重复事件也能走到当前窗口而 guard 不耗尽
    const daysBehindIter = Math.max(0, Math.ceil((from.getTime() - dtstart.toJSDate().getTime()) / 86_400_000));
    const guardLimit = Math.max(10_000, daysBehindIter + 4_000);
    let guard = 0;
    while (next && guard < guardLimit) {
      guard++;
      const jsDate = next.toJSDate();
      if (jsDate >= to) break;
      {
        const startIso = next.toString().replace("Z", "");
        if (!excludedFull.has(startIso) && !excludedDay.has(startIso.slice(0, 10))) {
          let endIso: string | undefined;
          if (duration) {
            const c = next.clone();
            c.addDuration(duration);
            endIso = c.toString().replace("Z", "");
          }
          emit(ev, startIso, endIso);
        }
      }
      next = iter.next();
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
