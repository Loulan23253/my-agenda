import { t } from "../l10n/strings";
import ICAL from "ical.js";
import type { CalendarEvent } from "../model/event";

/** iCalendar 文本 → v2 事件(取 VEVENT;VALARM 映射为提醒分钟)。 */
export function parseIcsToEvents(icsText: string, idPrefix = "", diagnostics?: { skipped: number }): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const jcal: unknown = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcal as string | unknown[]);
  if (comp.name !== "vcalendar") throw new Error("Expected a VCALENDAR resource");
  const overrides: CalendarEvent[] = [];
  for (const vevent of comp.getAllSubcomponents("vevent")) {
    // 毒块隔离:单个畸形 VEVENT(如 DTSTART:BANANA)解析失败只跳过该块,
    // 不拖垮整个解析(否则远端一条坏数据会让每轮同步全灭)
    try {
    const ev = new ICAL.Event(vevent);
    const uid = ev.uid;
    if (!uid) { if (diagnostics) diagnostics.skipped++; continue; }
    const start = ev.startDate;
    if (!start) { if (diagnostics) diagnostics.skipped++; continue; } // 缺 DTSTART 的坏块:跳过,不拖垮整轮解析
    const end = ev.endDate;
    const isAllDay = start.isDate;
    // TZID 在属性参数上(与 VTIMEZONE 注册无关——带 TZNAME 的 VTIMEZONE 会让 ical.js 退化成 floating)
    const startTzid = vevent.getFirstProperty("dtstart")?.getFirstParameter("tzid") as string | undefined;
    const endTzid = vevent.getFirstProperty("dtend")?.getFirstParameter("tzid") as string | undefined;
    const ev2: CalendarEvent = {
      id: idPrefix ? `${idPrefix}-${uid}` : uid,
      title: ev.summary || t("sync.untitled"),
      startsAt: isAllDay ? start.toString().slice(0, 10) : icalToLocalIso(start, startTzid),
      endsAt: end ? (isAllDay ? end.toString().slice(0, 10) : icalToLocalIso(end, endTzid)) : undefined,
      isAllDay,
    };
    const loc = vevent.getFirstPropertyValue("location");
    if (loc) ev2.place = String(loc);
    const desc = vevent.getFirstPropertyValue("description");
    if (desc) ev2.notes = String(desc);
    const cat = vevent.getFirstPropertyValue("categories");
    if (cat) ev2.category = String(cat).split(",")[0].trim();
    const status = vevent.getFirstPropertyValue("status");
    if (status) ev2.status = String(status).toLowerCase();
    try {
      const org = vevent.getFirstProperty("organizer");
      if (org) ev2.organizer = personFromProperty(org);
      const people: string[] = [];
      for (const a of vevent.getAllProperties("attendee")) people.push(personFromProperty(a));
      if (people.length) ev2.attendees = people;
      const url = vevent.getFirstPropertyValue("url");
      if (url) ev2.url = String(url);
    } catch {
      // 单字段解析失败不阻断整个事件
    }
    if (ev.component.hasProperty("rrule")) {
      const rr = ev.component.getFirstPropertyValue("rrule") as ICAL.Recur;
      ev2.repeats = { rule: rr.toString() };
    }
    const ex = ev.component.getAllProperties("exdate");
    if (ex.length) {
      const dates: string[] = [];
      for (const prop of ex) {
        let vals: unknown[] = [];
        try {
          vals = prop.getValues() as unknown[];
        } catch {
          continue; // 毒 EXDATE(如值类型与 DTSTART 不符):跳过该属性,不拖垮整轮解析
        }
        const exTzid = prop.getFirstParameter("tzid") as string | undefined;
        for (const v of vals) {
          if (v && typeof (v as ICAL.Time).toString === "function") {
            const t = v as ICAL.Time;
            // 与 startsAt/endsAt 相同的时区换算,保证排除匹配
            dates.push(isAllDay ? t.toString().slice(0, 10) : icalToLocalIso(t, exTzid));
          }
        }
      }
      if (dates.length) ev2.skippedDates = dates;
    }
    const alarms = ev.component.getAllSubcomponents("valarm");
    const minutes: number[] = [];
    for (const alarm of alarms) {
      const trigger = alarm.getFirstPropertyValue("trigger");
      if (trigger instanceof ICAL.Duration) minutes.push(-Math.round(trigger.toSeconds() / 60));
      else if (trigger instanceof ICAL.Time) {
        // 绝对时刻触发:换算成相对事件开始的分钟(早于开始为正)
        const diffMin = Math.round((trigger.toJSDate().getTime() - start.toJSDate().getTime()) / 60_000);
        if (diffMin > 0) minutes.push(diffMin);
      }
    }
    if (minutes.length) ev2.reminderMinutes = minutes;
    const rid = vevent.getFirstProperty("recurrence-id");
    if (rid) {
      const value = rid.getFirstValue() as ICAL.Time;
      ev2.recurrenceId = value.isDate ? value.toString().slice(0, 10) : icalToLocalIso(value, rid.getFirstParameter("tzid") as string | undefined);
      ev2.repeats = undefined;
      overrides.push(ev2);
    } else if (!out.some((e) => e.id === ev2.id)) out.push(ev2);
    } catch {
      if (diagnostics) diagnostics.skipped++;
      // 毒块隔离:解析失败的事件跳过,不影响其余事件
    }
  }
  for (const override of overrides) {
    let master = out.find((e) => e.id === override.id);
    if (!master) {
      // 无主系列的资源仍按一个 UID 存储，保留全部例外。
      master = { ...override, recurrenceOverrides: [] };
      out.push(master);
    }
    master.recurrenceOverrides ??= [];
    if (!master.recurrenceOverrides.some((o) => o.recurrenceId === override.recurrenceId)) master.recurrenceOverrides.push(override);
  }
  return out;
}

/** 从 ORGANIZER/ATTENDEE 属性整理出 "名字 <邮箱>"(缺一项则省略)。 */
function personFromProperty(prop: ICAL.Property): string {
  let email = "";
  let name = "";
  try {
    const cn = prop.getFirstParameter("cn");
    if (cn) name = String(cn).trim();
    const val = String(prop.getFirstValue()).replace(/^mailto:/i, "").trim();
    if (val.includes("@")) email = val;
    else if (!name) name = val;
  } catch {
    return "";
  }
  if (name && email) return `${name} <${email}>`;
  return name || email;
}

/** 某时区在给定 UTC 时刻的偏移(分钟)。用 Intl 内置 IANA 数据,不依赖 ical.js 的时区注册。 */
function zoneOffsetMinutes(tzid: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (ty: string) => Number(parts.find((x) => x.type === ty)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return (asUtc - utcMs) / 60_000;
}

/** ICAL.Time → 本地墙钟 ISO。
 *  floating(无 TZID):墙钟即本地语义,原样。
 *  带 TZID(UTC/VTIMEZONE):用 Intl IANA 数据把"该时区墙钟"换算为本地墙钟
 *  (两次迭代处理 DST 边界;不依赖 ical.js 的时区注册——它对带 TZNAME 的 VTIMEZONE 会退化成 floating)。 */
export function icalToLocalIso(t: ICAL.Time, tzid?: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  try {
    if (t.isDate) {
      return `${t.year}-${p(t.month)}-${p(t.day)}T00:00:00`;
    }
    // Z 后缀资源:ical.js 用 utcTimezone(无 tzid 字符串)→ 显式识别为 UTC
    const effTzid = tzid ?? (t.zone === ICAL.Timezone.utcTimezone ? "UTC" : "");
    if (effTzid && effTzid.toLowerCase() !== "floating") {
      const wallMs = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
      const off1 = zoneOffsetMinutes(effTzid, wallMs);
      const instant = wallMs - off1 * 60_000;
      const off2 = zoneOffsetMinutes(effTzid, instant);
      const d = new Date(wallMs - off2 * 60_000);
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  } catch {
    /* 时区换算失败按 floating 墙钟兜底 */
  }
  return `${t.year}-${p(t.month)}-${p(t.day)}T${p(t.hour)}:${p(t.minute)}:${p(t.second)}`;
}function normalizeIso(s: string, isAllDay: boolean): string {
  return isAllDay ? s.slice(0, 10) : s.replace("Z", "");
}
