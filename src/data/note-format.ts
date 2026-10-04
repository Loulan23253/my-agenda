/**
 * v2 干净笔记格式:字段行只描述日程本身,同步元数据一律不落盘。
 * 解析器同时容忍 v1 遗留字段(uid/start/end/all_day/etag/…),
 * 供迁移器把旧数据搬进账本。
 */
import type { CalendarEvent } from "../model/event";
import { normalizeEnd } from "../kernel/dates";

export const MONTH_FILE_RE = /^\d{4}-\d{2}\.md$/;

export interface NoteBlock {
  heading: string;
  fields: Record<string, string>;
  fieldOrder: string[];
  prose: string;
}

export interface ParsedMonthlyNote {
  preamble: string;
  blocks: NoteBlock[];
}

const HEADING = /^##\s+(.+)$/;
const FIELD = /^-\s+([A-Za-z0-9_]+)::\s?(.*)$/;

export function parseMonthlyNote(text: string): ParsedMonthlyNote {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const preamble: string[] = [];
  const blocks: NoteBlock[] = [];
  let cur: NoteBlock | null = null;
  let inFields = false;
  const prose: string[] = [];

  const flush = () => {
    if (!cur) return;
    blocks.push({
      heading: cur.heading,
      fields: cur.fields,
      fieldOrder: cur.fieldOrder,
      prose: prose.join("\n").replace(/^\n+/, "").replace(/\n+$/, ""),
    });
    cur = null;
    prose.length = 0;
    inFields = false;
  };

  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      flush();
      cur = { heading: h[1].trim(), fields: {}, fieldOrder: [], prose: "" };
      inFields = true; // 标题之后先是字段区,直到第一行非字段内容
      continue;
    }
    if (!cur) {
      preamble.push(line);
      continue;
    }
    if (inFields) {
      const f = FIELD.exec(line);
      if (f) {
        cur.fieldOrder.push(f[1]);
        cur.fields[f[1]] = f[2];
        continue;
      }
      inFields = false;
    }
    prose.push(line);
  }
  flush();
  return { preamble: preamble.join("\n").replace(/\n+$/, ""), blocks };
}

/** v2 字段名(与 v1 的 uid/start/end/all_day 有意不同,便于区分来源)。 */
const V2_KEYS = ["id", "starts", "ends", "allday", "tz", "place", "category", "organizer", "attendees", "url", "repeat", "skip", "remind", "status"] as const;
/** v1 遗留字段名 → v2 含义(迁移器只读取,不再写回)。 */
const V1_ALIASES: Record<string, string> = {
  uid: "id",
  start: "starts",
  end: "ends",
  all_day: "allday",
  tz: "tz",
  location: "place",
  category: "category",
  rrule: "repeat",
  exdates: "skip",
  reminder: "remind",
  reminders: "remind",
};

function readField(fields: Record<string, string>, v2key: string): string | undefined {
  if (V2_KEYS.includes(v2key as (typeof V2_KEYS)[number]) && fields[v2key] !== undefined) return fields[v2key];
  for (const [v1, mapped] of Object.entries(V1_ALIASES)) {
    if (mapped === v2key && fields[v1] !== undefined) return fields[v1];
  }
  return undefined;
}

function unescapeText(s: string): string {
  return s.replace(/\\(\\|n)/g, (_m, c) => (c === "n" ? "\n" : "\\"));
}

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n");
}

/** 从一个笔记块还原事件(容错 v1/v2 两种字段来源)。不完整(id 或 starts 缺失)返回 null。 */
export function blockToEvent(block: NoteBlock): CalendarEvent | null {
  const id = readField(block.fields, "id");
  const starts = readField(block.fields, "starts");
  if (!id || !starts) return null;
  const ends = readField(block.fields, "ends");
  const allDayRaw = readField(block.fields, "allday");
  const allday = allDayRaw !== undefined ? allDayRaw === "true" : !starts.includes("T");
  const ev: CalendarEvent = {
    id,
    title: block.heading.replace(/^\d{1,2}:\d{2}([-–—]\d{1,2}:\d{2})?\s*/, "").trim() || block.heading.trim(),
    startsAt: starts,
    // 历史数据可能存有"结束<=开始"(跨午夜取模 bug):加载即归一化,渲染与推送都用合法值
    endsAt: ends && !allday && ends <= starts ? normalizeEnd(starts, ends) : ends,
    status: readField(block.fields, "status") || undefined,
    isAllDay: allday,
  };
  const tz = readField(block.fields, "tz");
  if (tz) ev.timeZone = tz;
  const place = readField(block.fields, "place");
  if (place) ev.place = place;
  const cat = readField(block.fields, "category");
  if (cat) ev.category = cat;
  const organizer = readField(block.fields, "organizer");
  if (organizer) ev.organizer = organizer;
  const attendees = readField(block.fields, "attendees");
  if (attendees) ev.attendees = attendees.split(",").map((x) => x.trim()).filter(Boolean);
  const url = readField(block.fields, "url");
  if (url) ev.url = url;
  const repeat = readField(block.fields, "repeat");
  if (repeat) ev.repeats = { rule: repeat };
  const skip = readField(block.fields, "skip");
  if (skip) ev.skippedDates = skip.split(",").map((x) => x.trim()).filter(Boolean);
  const remind = readField(block.fields, "remind");
  if (remind) {
    const nums = remind.split(",").map((x) => Number.parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n));
    if (nums.length) ev.reminderMinutes = nums;
  }
  const notes = unescapeText(block.prose).trim();
  if (notes) ev.notes = notes;
  return ev;
}

function hhmm(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : "";
}

// 远端数据(标题/字段值)一律压成单行:防止 ICS 换行注入破坏笔记结构或伪造字段
function oneLine(s: string): string {
  return s.replace(/\r?\n/g, " ");
}

export function eventHeading(ev: CalendarEvent): string {
  if (ev.isAllDay) return oneLine(ev.title);
  const s = hhmm(ev.startsAt);
  const e = ev.endsAt ? hhmm(ev.endsAt) : "";
  const span = s ? (e ? `${s}–${e}` : s) : "";
  return span ? `${span} ${oneLine(ev.title)}` : oneLine(ev.title);
}

export function eventToFields(ev: CalendarEvent): Record<string, string> {
  const f: Record<string, string> = { id: ev.id, starts: ev.startsAt };
  if (ev.endsAt) f.ends = ev.endsAt;
  f.allday = ev.isAllDay ? "true" : "false";
  if (ev.timeZone) f.tz = ev.timeZone;
  if (ev.place) f.place = ev.place;
  if (ev.category) f.category = ev.category;
  if (ev.organizer) f.organizer = ev.organizer;
  if (ev.attendees?.length) f.attendees = ev.attendees.join(", ");
  if (ev.url) f.url = ev.url;
  if (ev.repeats) f.repeat = ev.repeats.rule;
  if (ev.skippedDates?.length) f.skip = ev.skippedDates.join(", ");
  if (ev.reminderMinutes?.length) f.remind = ev.reminderMinutes.join(", ");
  return f;
}

const META_KEYS = new Set(["etag", "href", "base_hash", "origin", "server_deleted"]);

export function serializeBlock(ev: CalendarEvent, existing?: NoteBlock): string {
  const fields = eventToFields(ev);
  for (const k of Object.keys(fields)) fields[k] = oneLine(fields[k]);
  if (ev.status) fields["status"] = ev.status; // 必须在 order 计算前写入,否则新块/状态变更不会落盘
  const order = existing?.fieldOrder.filter((k) => k in fields) ?? [];
  for (const k of Object.keys(fields)) if (!order.includes(k)) order.push(k);
  // 未知键透传:v1 的 source/protocol/seq 等扩展字段原样保留
  const passthrough: string[] = [];
  for (const k of existing?.fieldOrder ?? []) {
    if (!(k in fields) && !META_KEYS.has(k) && !passthrough.includes(k)) passthrough.push(k);
  }
  const heading = eventHeading(ev);
  if (ev.status) fields["status"] = ev.status;
  const fieldLines = order.map((k) => `- ${k}:: ${fields[k]}`);
  for (const k of passthrough) fieldLines.push(`- ${k}:: ${existing!.fields[k]}`);
  const prose = ev.notes ? `\n\n${escapeText(ev.notes)}` : "";
  let out = `## ${heading}`;
  if (fieldLines.length) out += `\n${fieldLines.join("\n")}`;
  out += prose;
  return out;
}

/** 未知/无法解析的块原样重建:标题 + 既有字段 + 正文,一字不丢。 */
export function serializeRawBlock(b: NoteBlock): string {
  let out = `## ${b.heading}`;
  const fieldLines = b.fieldOrder
    .filter((k) => b.fields[k] !== undefined)
    .map((k) => `- ${k}:: ${b.fields[k]}`);
  if (fieldLines.length) out += `\n${fieldLines.join("\n")}`;
  if (b.prose && b.prose.trim().length) out += `\n\n${b.prose}`;
  return out;
}

export function serializeMonthlyNote(preamble: string, blocks: string[]): string {
  const parts: string[] = [];
  if (preamble.trim().length) parts.push(preamble);
  parts.push(...blocks);
  return parts.join("\n\n") + "\n";
}
