import type { CalendarEvent } from "../model/event";
import { normalizeEnd } from "../kernel/dates";

/** 拆 "名字 <邮箱>" / 纯邮箱 / 纯名字。 */
function splitPerson(s: string): { name: string; email: string } {
  const lt = s.indexOf("<");
  if (lt >= 0) {
    const email = s.slice(lt + 1, s.indexOf(">", lt)).trim();
    return { name: s.slice(0, lt).trim(), email };
  }
  const m = /[\w.+-]+@[\w.-]+/.exec(s);
  if (m) return { name: s.replace(m[0], "").trim(), email: m[0] };
  return { name: s.trim(), email: "" };
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function fold(line: string): string {
  if (line.length <= 73) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    parts.push(rest.slice(0, 73));
    rest = " " + rest.slice(73);
  }
  parts.push(rest);
  return parts.join("\r\n");
}

function addOneDay(dateKeyStr: string): string {
  const [y, m, d] = dateKeyStr.split("-").map(Number);
  const next = new Date(y, m - 1, d + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${next.getFullYear()}${p(next.getMonth() + 1)}${p(next.getDate())}`;
}

function eventLines(ev: CalendarEvent, dtstamp: string): string[] {
  const lines: string[] = ["BEGIN:VEVENT", `DTSTAMP:${dtstamp}`, `UID:${ev.id}`, `SUMMARY:${icsEscape(ev.title)}`];
  if (ev.recurrenceId) {
    const rid = ev.recurrenceId.replace(/[-:]/g, "");
    lines.push(`RECURRENCE-ID${ev.recurrenceId.includes("T") ? "" : ";VALUE=DATE"}:${rid}`);
  }
  // iCloud 拒绝没有 DTEND 的 PUT(哪怕 RFC 5545 说可省):永远发送 DTEND。
  // 无结束时间 = 与开始相同(定时)/次日(全天,排他语义)。
  if (ev.isAllDay) {
    const start = ev.startsAt.replace(/-/g, "");
    const end = ev.endsAt && ev.endsAt > ev.startsAt ? ev.endsAt.replace(/-/g, "") : addOneDay(ev.startsAt);
    lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`);
  } else {
    // iCloud 拒收 DTEND <= DTSTART:历史坏数据在此兜底归一化
    let endIso = ev.endsAt ?? ev.startsAt;
    if (endIso <= ev.startsAt) endIso = normalizeEnd(ev.startsAt, endIso);
    const start = ev.startsAt.replace(/[-:]/g, "").slice(0, 15);
    const end = endIso.replace(/[-:]/g, "").slice(0, 15);
    lines.push(`DTSTART:${start}`, `DTEND:${end}`);
  }
  if (ev.place) lines.push(`LOCATION:${icsEscape(ev.place)}`);
  if (ev.notes) lines.push(`DESCRIPTION:${icsEscape(ev.notes)}`);
  if (ev.category) lines.push(`CATEGORIES:${icsEscape(ev.category)}`);
  if (ev.organizer) {
    const { name, email } = splitPerson(ev.organizer);
    if (email) lines.push(fold(`ORGANIZER${name ? `;CN=${icsEscape(name)}` : ""}:mailto:${email}`));
  }
  for (const a of ev.attendees ?? []) {
    const { name, email } = splitPerson(a);
    if (email) lines.push(fold(`ATTENDEE${name ? `;CN=${icsEscape(name)}` : ""}:mailto:${email}`));
  }
  if (ev.url) lines.push(`URL:${icsEscape(ev.url)}`);
  if (ev.status) lines.push(`STATUS:${ev.status.toUpperCase()}`);
  if (ev.repeats) lines.push(`RRULE:${ev.repeats.rule}`);
  for (const x of ev.skippedDates ?? []) {
    // RFC 5545:EXDATE 值类型必须与 DTSTART 一致(全天=DATE,定时=DATE-TIME 带原时刻)
    if (ev.isAllDay) {
      lines.push(`EXDATE;VALUE=DATE:${x.replace(/[-:]/g, "").slice(0, 8)}`);
    } else {
      const date = x.slice(0, 10).replace(/-/g, "");
      const time = x.length >= 16 ? x.slice(11, 16).replace(":", "") : "000000";
      lines.push(`EXDATE:${date}T${time}00`);
    }
  }
  for (const m of ev.reminderMinutes ?? []) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:-PT${Math.abs(m)}M`, "END:VALARM");
  }
  lines.push("END:VEVENT");
  return lines.map(fold);
}

export function buildIcs(events: CalendarEvent[]): string {
  const now = new Date();
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const dtstamp = `${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}T${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}Z`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//myagenda-v2//CN", "CALSCALE:GREGORIAN"];
  for (const ev of events) {
    if (!ev.id || !ev.startsAt) continue;
    if (!ev.recurrenceId || !ev.recurrenceOverrides?.length) lines.push(...eventLines(ev, dtstamp));
    for (const override of ev.recurrenceOverrides ?? []) {
      lines.push(...eventLines({ ...override, id: ev.id, repeats: undefined, recurrenceOverrides: undefined }, dtstamp));
    }
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
