/**
 * 日记注入:把当天日程以 `>>- [ ]` 待办清单注入到标记行之后。
 * 幂等:force=false 仅追加缺失条目、force=true 重建;绝不触碰用户内容。
 */
import type { Occurrence } from "../core/occurrences";

const INJECT_MARK = "<!--ag2-injected-->";
const ITEM_MARK = /\s*<!--ag2-item:[^>]*-->/g;
const EVENT_MARK = /\s*<!--ag2-event:([^>]*)-->/;
const INSTANCE_MARK = /\s*<!--ag2-instance:([^>]*)-->/;
const SKIP_MARK = /^\s*>\s*<!--ag2-skipped:([^>]*)-->\s*$/;
const INJECT_ROW = /^(?:>[ \t]*){1,2}-\s/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function markerRe(marker: string): RegExp {
  return new RegExp("^" + escapeRe(marker) + "(\\s*" + escapeRe(INJECT_MARK) + ")?[ \\t]*$", "m");
}

export interface InjectItem {
  /** 日记内的稳定身份；只影响注入，不改日历事件。 */
  eventId?: string;
  instanceKey?: string;
  title: string;
  allDay: boolean;
  startTime?: string;
  endTime?: string;
  place?: string;
  category?: string;
}

export function buildInjectList(occs: Occurrence[]): InjectItem[] {
  return normalizeItems(occs.map((o) => ({
    eventId: o.event.id,
    instanceKey: JSON.stringify([o.event.id, o.event.recurrenceId ?? (o.event.repeats ? o.start : "")]),
    title: o.event.title,
    allDay: o.event.isAllDay,
    startTime: o.event.isAllDay ? undefined : o.start.slice(11, 16),
    endTime: o.event.isAllDay || !o.end ? undefined : o.end.slice(11, 16),
    place: o.event.place,
    category: o.event.category,
  })));
}

function normalizeItems(items: InjectItem[]): InjectItem[] {
  const seen = new Map<string, InjectItem>();
  for (const it of items) {
    const key = it.title + "|" + (it.startTime ?? "");
    if (!seen.has(key)) seen.set(key, it);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return (a.startTime ?? "").localeCompare(b.startTime ?? "");
  });
}

export interface InjectFormat {
  /** 条目用勾选框(否则无框)。 */
  checkbox: boolean;
  /** 显示地点。 */
  place: boolean;
  /** 显示分类。 */
  category: boolean;
  /** 行前缀:">>"(嵌套引用,默认)或 ">"。 */
  prefix: string;
  /** 时间制式(默认 24h)。 */
  timeFormat?: "24h" | "12h";
}

export type InjectStatus = "injected" | "cleared" | "no-events" | "no-marker" | "skipped";

/** 从旧注入行提取 "时刻前缀+标题" 键(剥掉勾选框/📍/🏷️),用于重建时保留勾选状态。 */
function checkedKeysFrom(oldBlock: string[]): Set<string> {
  const keys = new Set<string>();
  for (const line of oldBlock) {
    const m = /^(?:>[ \t]*){1,2}-\s*\[x\]\s+(.*)$/i.exec(line.trim()); // 兼容历史 >>(保留);新前缀由 itemKey 侧无关
    if (!m) continue;
    keys.add(itemKey(m[1].replace(/\s*[📍🏷].*$/u, "").trimEnd()));
  }
  return keys;
}

function itemKey(text: string): string {
  const clean = text.replace(ITEM_MARK, "").replace(EVENT_MARK, "").replace(INSTANCE_MARK, "").replace(/\s*[📍🏷].*$/u, "").trim();
  const m = /^(\d{1,2}):(\d{2})(?:\s+(AM|PM))?(?:-\d{1,2}:\d{2}(?:\s+(?:AM|PM))?)?\s+(.*)$/i.exec(clean);
  if (!m) return `|${clean}`;
  let hour = Number(m[1]);
  if (m[3]) hour = hour % 12 + (m[3].toUpperCase() === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${m[2]}|${m[4]}`;
}

export interface InjectedTask {
  line?: number;
  key: string;
  row: string;
  label: string;
  eventId?: string;
  instanceKey?: string;
}

function decode(s: string): string | undefined {
  try { return decodeURIComponent(s); } catch { return undefined; }
}

/** 只识别插件生成的逐行标记，不能把用户手写待办当成日程。 */
export function injectedTaskKey(row: string): string | undefined {
  if (!INJECT_ROW.test(row.trim())) return undefined;
  const mark = /<!--ag2-item:([^>]*)-->/.exec(row);
  return mark ? decode(mark[1]) : undefined;
}

function taskFromRow(row: string): InjectedTask {
  const text = row.trim().replace(INJECT_ROW, "").replace(/^\[[^\]]*\]\s*/, "");
  const eventMark = EVENT_MARK.exec(row);
  const instanceMark = INSTANCE_MARK.exec(row);
  return {
    key: injectedTaskKey(row) ?? itemKey(text), row,
    label: text.replace(ITEM_MARK, "").replace(EVENT_MARK, "").replace(INSTANCE_MARK, "").trim(),
    eventId: eventMark ? decode(eventMark[1]) : undefined,
    instanceKey: instanceMark ? decode(instanceMark[1]) : undefined,
  };
}

function injectionRows(content: string, marker: string): { lines: string[]; from: number; to: number } | undefined {
  const match = content.match(markerRe(marker));
  if (!match) return undefined;
  const lines = content.split("\n");
  const from = content.slice(0, match.index).split("\n").length;
  let to = from;
  for (let i = from; i < lines.length; i++) {
    const row = lines[i].trim();
    if (row.includes(INJECT_MARK) || INJECT_ROW.test(row) || SKIP_MARK.test(row)) to = i + 1;
    else if (row !== "" && !/^>\s*$/.test(row)) break;
  }
  return { lines, from, to };
}

function skippedTask(row: string): InjectedTask | undefined {
  const match = SKIP_MARK.exec(row);
  if (!match) return undefined;
  try {
    const record = JSON.parse(decodeURIComponent(match[1]));
    if (typeof record.row !== "string" || /\n|\r(?!$)/.test(record.row) || !INJECT_ROW.test(record.row.trim())) return undefined;
    const task = taskFromRow(record.row);
    return record.key === task.key ? { ...task,
      eventId: task.eventId ?? (typeof record.eventId === "string" ? record.eventId : undefined),
      instanceKey: task.instanceKey ?? (typeof record.instanceKey === "string" ? record.instanceKey : undefined),
    } : undefined;
  } catch { return undefined; }
}

export function listInjectedTasks(content: string, marker: string, items: InjectItem[] = []): InjectedTask[] {
  const block = injectionRows(content, marker);
  if (!block) return [];
  const rows = block.lines.slice(block.from, block.to);
  const legacy = rows.some((row) => row.includes(INJECT_MARK)) || content.match(markerRe(marker))?.[0].includes(INJECT_MARK);
  const keys = new Set(items.map((it) => itemKey(`${!it.allDay && it.startTime ? it.startTime + " " : ""}${it.title}`)));
  return rows.map((row, index) => ({ row, line: block.from + index })).filter(({ row }) => INJECT_ROW.test(row.trim()))
    .map(({ row, line }) => ({ ...taskFromRow(row), line })).filter((task) => injectedTaskKey(task.row) !== undefined || (legacy && keys.has(task.key)));
}

export function listSkippedTasks(content: string, marker: string): InjectedTask[] {
  const block = injectionRows(content, marker);
  return block ? block.lines.slice(block.from, block.to).flatMap((row, index) => {
    const task = skippedTask(row); return task ? [{ ...task, line: block.from + index }] : [];
  }) : [];
}

/** 把原行保存在日记的隐藏注释中，随日记同步；日历与手写任务不受影响。 */
export function skipInjectedTask(content: string, marker: string, key: string, items: InjectItem[] = []): string {
  const block = injectionRows(content, marker);
  const task = listInjectedTasks(content, marker, items).find((task) => task.key === key);
  if (!block || !task) return content;
  const index = block.lines.findIndex((row, i) => i >= block.from && i < block.to && row === task.row);
  const item = items.find((it) => itemKey(`${!it.allDay && it.startTime ? it.startTime + " " : ""}${it.title}`) === task.key);
  block.lines[index] = `> <!--ag2-skipped:${encodeURIComponent(JSON.stringify({ key: task.key, row: task.row,
    eventId: task.eventId ?? item?.eventId, instanceKey: task.instanceKey ?? item?.instanceKey,
  }))}-->`;
  return block.lines.join("\n");
}

export function restoreSkippedTask(content: string, marker: string, key: string): string {
  const block = injectionRows(content, marker);
  if (!block) return content;
  const index = block.lines.findIndex((row, i) => i >= block.from && i < block.to && skippedTask(row)?.key === key);
  if (index < 0) return content;
  const task = skippedTask(block.lines[index])!;
  const exists = block.lines.slice(block.from, block.to).some((row) => INJECT_ROW.test(row.trim()) && taskFromRow(row).key === key);
  if (exists) block.lines.splice(index, 1);
  else block.lines[index] = task.row;
  return block.lines.join("\n");
}

export function applyInjection(
  content: string,
  opts: { marker: string; items: InjectItem[]; force?: boolean; preserveChecked?: boolean; format?: InjectFormat },
): { content: string; status: InjectStatus; count?: number } {
  const mm = content.match(markerRe(opts.marker));
  if (!mm) return { content, status: "no-marker" };
  const start = mm.index;
  let lineEnd = content.indexOf("\n", start);
  if (lineEnd === -1) lineEnd = content.length;
  const markerLine = content.slice(start, lineEnd).replace(new RegExp(">?\\s*" + escapeRe(INJECT_MARK) + "\\s*$"), "");

  const after = content.slice(lineEnd === content.length ? content.length : lineEnd + 1).split("\n");
  let keep = 0;
  for (let i = 0; i < after.length; i++) {
    const trimmed = after[i].trim();
    if (trimmed.includes(INJECT_MARK) || INJECT_ROW.test(trimmed) || SKIP_MARK.test(trimmed)) keep = i + 1;
    else if (trimmed !== "" && !/^>\s*$/.test(trimmed)) break;
  }
  const rest = after.slice(keep).join("\n").replace(/^\n+/, "");
  const skipped = listSkippedTasks(content, opts.marker);
  const sameTask = (task: InjectedTask, other: { key: string; eventId?: string; instanceKey?: string }) =>
    task.instanceKey && other.instanceKey ? task.instanceKey === other.instanceKey :
      task.eventId && other.eventId ? task.eventId === other.eventId : task.key === other.key;
  // iCloud 合并可能让隐藏标记与旧可见行同时出现；只清理已明确跳过的插件行。
  const oldBlock = after.slice(0, keep).filter((row) => {
    if (!INJECT_ROW.test(row.trim())) return true;
    const task = taskFromRow(row);
    return !skipped.some((hidden) => (injectedTaskKey(row) !== undefined || hidden.row === row) && sameTask(hidden, task));
  });
  const removedSkipped = oldBlock.length !== keep;
  const cleanedContent = removedSkipped ? content.slice(0, lineEnd) + "\n" + [...oldBlock, ...after.slice(keep)].join("\n") : content;
  const allItems = normalizeItems(opts.items);
  const list = allItems.filter((it) => !skipped.some((task) => sameTask(task, {
    ...it, key: itemKey(`${!it.allDay && it.startTime ? it.startTime + " " : ""}${it.title}`),
  })));
  const incomingKeys = new Set(allItems.map((it) => itemKey(`${!it.allDay && it.startTime ? it.startTime + " " : ""}${it.title}`)));
  const hasLegacyMarker = oldBlock.some((line) => line.includes(INJECT_MARK)) || mm[0].includes(INJECT_MARK);
  // 新条目逐行标记归属。历史无逐行标记的内容，只接管能与当前日程匹配的行。
  const owned = (line: string) => line.includes("<!--ag2-item:") ||
    (hasLegacyMarker && INJECT_ROW.test(line.trim()) && incomingKeys.has(itemKey(line.trim().replace(INJECT_ROW, "").replace(/^\[[^\]]*\]\s*/, ""))));
  const preserved = oldBlock.filter((line) => !owned(line) && !line.includes(INJECT_MARK)).join("\n");
  const checked = opts.preserveChecked ? checkedKeysFrom(oldBlock) : new Set<string>();
  if (list.length === 0) {
    if (opts.force && (keep > 0 || content.includes(INJECT_MARK)))
      return { content: content.slice(0, start) + markerLine + "\n" + preserved + (preserved && rest ? "\n\n" : "") + rest, status: "cleared" };
    return { content: cleanedContent, status: removedSkipped ? "cleared" : keep > 0 ? "skipped" : "no-events" };
  }

  const fmt = { checkbox: true, place: true, category: true, prefix: ">>", timeFormat: "24h" as const, ...(opts.format ?? {}) };
  const hhmm12 = (t: string): string => {
    const [h, m] = t.split(":").map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
  };
  const lines = [">" + INJECT_MARK];
  for (const it of list) {
    let time = "";
    if (!it.allDay && it.startTime && !/^\d{1,2}:\d{2}/.test(it.title)) {
      if (fmt.timeFormat === "12h") {
        time = (it.endTime ? `${hhmm12(it.startTime)}-${hhmm12(it.endTime)}` : hhmm12(it.startTime)) + " ";
      } else {
        time = it.endTime ? `${it.startTime}-${it.endTime} ` : `${it.startTime} `;
      }
    }
    const place = it.place && fmt.place ? "📍" + it.place + " " : "";
    const cat = it.category && fmt.category ? "🏷️" + it.category + " " : "";
    const box = fmt.checkbox ? (checked.has(itemKey(`${time}${it.title}`.trimEnd())) ? "[x]" : "[ ]") : "";
    const pfx = `${fmt.prefix}- ${box ? box + " " : ""}`;
    lines.push(`${pfx}${time}${it.title} ${place}${cat}`.trimEnd() + ` <!--ag2-item:${encodeURIComponent(itemKey(`${time}${it.title}`))}-->` +
      (it.eventId ? ` <!--ag2-event:${encodeURIComponent(it.eventId)}-->` : "") +
      (it.instanceKey ? ` <!--ag2-instance:${encodeURIComponent(it.instanceKey)}-->` : ""));
  }
  if (!opts.force && keep > 0) {
    const existing = new Set(oldBlock.filter((line) => INJECT_ROW.test(line.trim())).map((line) =>
      itemKey(line.trim().replace(INJECT_ROW, "").replace(/^\[[^\]]*\]\s*/, "")),
    ));
    const added = lines.slice(1).filter((line) => !existing.has(itemKey(line.replace(INJECT_ROW, "").replace(/^\[[^\]]*\]\s*/, ""))));
    if (!added.length) return { content: cleanedContent, status: removedSkipped ? "cleared" : "skipped" };
    // 原有条目（包括勾选、用户编辑和顺序）保持原样，只在块尾补新条目。
    const tail = after.slice(keep).join("\n");
    const head = content.slice(0, lineEnd) + "\n" + oldBlock.join("\n");
    return { content: head + "\n" + added.join("\n") + "\n" + tail, status: "injected", count: added.length };
  }
  const block = lines.join("\n");
  const head = content.slice(0, start) + markerLine + "\n";
  const remaining = [preserved, rest].filter(Boolean).join("\n\n");
  return { content: head + (remaining ? block + "\n\n" + remaining : block + "\n"), status: "injected", count: list.length };
}
