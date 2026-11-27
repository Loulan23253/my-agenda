/**
 * 月度笔记仓库:日程的唯一用户可见载体(每月一个 YYYY-MM.md)。
 * 读取时同时抽取 v1 遗留同步字段(etag/href),供迁移器播种账本;
 * 写入一律产出 v2 干净格式。
 */
import type { CalendarEvent } from "../model/event";
import { MONTH_FILE_RE, parseMonthlyNote, blockToEvent, serializeBlock, type NoteBlock } from "./note-format";
import type { KeyValueFileIO } from "./io";

export function monthOf(startsAt: string): string {
  const m = /^(\d{4}-\d{2})/.exec(startsAt);
  return m ? m[1] : "unknown";
}

/** v1 遗留元数据:旧笔记字段里的 href/etag,迁移时播种进账本。 */
export interface LegacyMeta {
  href?: string;
  etag?: string;
}

export interface LoadedMonthData {
  events: CalendarEvent[];
  /** Original text for detecting concurrent edits to the same event. */
  originals: Map<string, string>;
  unreadable: { file: string; heading: string }[];
  duplicateMonths: Record<string, number>;
  /** uid → v1 遗留元数据(仅当笔记字段里存在时)。 */
  legacy: Record<string, LegacyMeta>;
  /** 无法还原的块数；不包含已成功解析的同 ID 副本。 */
  skipped: number;
  /** 已解析，但同 ID 已读取过的块数。 */
  duplicates: number;
}

/** Keep raw sections so that unrelated Markdown survives byte-for-byte. */
function sections(text: string) {
  const headings = [...text.matchAll(/^##[^\S\r\n]+[^\r\n]+(?=\r?$)/gm)];
  return {
    prefix: text.slice(0, headings[0]?.index ?? text.length),
    blocks: headings.map((h, i) => {
      const raw = text.slice(h.index, headings[i + 1]?.index ?? text.length);
      const block = parseMonthlyNote(raw).blocks[0];
      return { raw, block, id: block.fields.id ?? block.fields.uid };
    }),
  };
}

function eventLike(b: NoteBlock): boolean {
  return ["id", "uid", "starts", "start", "ends", "end", "overrides", "recurrence_id"].some(key => key in b.fields);
}

/** Only competing edits to targeted blocks block the write. */
function checkTargets(current: string, original: string | undefined, ids: ReadonlySet<string>, path: string): void {
  if (original === undefined || current === original) return;
  const grouped = (text: string) => {
    const byId = new Map<string, string[]>();
    for (const { id, raw } of sections(text).blocks) {
      if (!ids.has(id)) continue;
      const group = byId.get(id) ?? [];
      group.push(raw.trimEnd());
      byId.set(id, group);
    }
    return byId;
  };
  const before = grouped(original), now = grouped(current);
  for (const id of ids) {
    if (JSON.stringify(before.get(id)) !== JSON.stringify(now.get(id))) {
      throw new Error(`${path} 中的目标日程刚被修改，已保留当前文件。请刷新日程后重试。`);
    }
  }
}

export class MonthlyNoteStore {
  constructor(
    private readonly io: KeyValueFileIO,
    private readonly folder: string,
    private readonly onWrite?: (path: string) => void,
  ) {}

  private monthPath(month: string): string {
    return `${this.folder}/${month}.md`;
  }

  async listMonthPaths(): Promise<string[]> {
    const all = await this.io.listFiles(this.folder);
    return all.filter((p) => MONTH_FILE_RE.test(p.slice(p.lastIndexOf("/") + 1))).sort();
  }

  /** 全量读取(跨月文件:重复事件的定义可能在任意月份)。 */
  async loadAll(): Promise<LoadedMonthData> {
    const events: CalendarEvent[] = [];
    const legacy: Record<string, LegacyMeta> = {};
    const originals = new Map<string, string>();
    const unreadable: LoadedMonthData["unreadable"] = [];
    const duplicateMonths: Record<string, number> = {};
    let duplicates = 0;
    const seen = new Set<string>();
    for (const path of await this.listMonthPaths()) {
      const text = await this.io.readText(path);
      if (text === null) continue;
      originals.set(path, text);
      const file = path.slice(path.lastIndexOf("/") + 1);
      const { blocks } = parseMonthlyNote(text);
      for (const b of blocks) {
        const ev = blockToEvent(b);
        if (!ev) {
          if (eventLike(b)) unreadable.push({ file, heading: b.heading });
          continue;
        }
        // 跨月残留的同 id 块只认最早一份(全量写回时另一份会被清掉)
        if (seen.has(ev.id)) {
          duplicates++;
          duplicateMonths[file] = (duplicateMonths[file] ?? 0) + 1;
          continue;
        }
        seen.add(ev.id);
        events.push(ev);
        const href = b.fields["href"];
        const etag = b.fields["etag"];
        if (href || etag) legacy[ev.id] = { href, etag };
      }
    }
    return { events, legacy, skipped: unreadable.length, duplicates, duplicateMonths, unreadable, originals };
  }

  private async update(path: string, edit: (text: string | null) => string | null): Promise<void> {
    let changed = false;
    const transform = (text: string | null) => {
      const next = edit(text);
      changed = next !== null && text !== next;
      return next;
    };
    if (this.io.updateText) await this.io.updateText(path, transform);
    else {
      const next = transform(await this.io.readText(path));
      if (changed && next !== null) await this.io.writeText(path, next);
    }
    if (changed) this.onWrite?.(path);
  }

  /** Apply only the supplied events; untouched sections keep their exact Markdown. */
  async writeMonth(month: string, events: CalendarEvent[], preamble = "", originals?: Map<string, string>): Promise<void> {
    await this.io.ensureDir(this.folder);
    const path = this.monthPath(month);
    const byId = new Map(events.map(e => [e.id, e]));
    const ids = new Set(byId.keys());
    await this.update(path, current => {
      const text = current ?? "";
      checkTargets(text, originals && (originals.get(path) ?? ""), ids, path);
      const parsed = sections(text);
      const nl = text.includes("\r\n") ? "\r\n" : "\n";
      let out = current === null ? preamble : parsed.prefix;
      const emitted = new Set<string>();
      for (const { raw, block, id } of parsed.blocks) {
        const ev = byId.get(id);
        if (!ev) {
          out += raw;
          continue;
        }
        if (monthOf(ev.startsAt) !== month || emitted.has(id)) continue;
        emitted.add(id);
        const ending = raw.match(/(?:\r?\n)*$/)?.[0] ?? "";
        out += serializeBlock(ev, block).replace(/\n/g, nl) + ending;
      }
      const fresh = events.filter(e => monthOf(e.startsAt) === month && !emitted.has(e.id))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      for (const ev of fresh) {
        if (out && !out.endsWith(nl)) out += nl;
        if (out && !out.endsWith(nl + nl)) out += nl;
        out += serializeBlock(ev).replace(/\n/g, nl) + nl;
      }
      return current === null && !out ? null : out;
    });
  }

  /** Write destinations before cleaning old months, including on a cross-month move. */
  async saveChanges(events: CalendarEvent[], loaded: LoadedMonthData): Promise<string[]> {
    const destinations = new Map<string, CalendarEvent[]>();
    const movedFrom = new Map<string, CalendarEvent[]>();
    const oldById = new Map(loaded.events.map(e => [e.id, e]));
    for (const ev of new Map(events.map(e => [e.id, e])).values()) {
      const month = monthOf(ev.startsAt);
      if (!destinations.has(month)) destinations.set(month, []);
      destinations.get(month)!.push(ev);
      const old = oldById.get(ev.id);
      if (old && monthOf(old.startsAt) !== month) {
        const from = monthOf(old.startsAt);
        if (!movedFrom.has(from)) movedFrom.set(from, []);
        movedFrom.get(from)!.push(ev);
      }
    }
    for (const group of [destinations, movedFrom]) {
      for (const [month, changes] of group) await this.writeMonth(month, changes, "", loaded.originals);
    }
    return [...new Set([...destinations.keys(), ...movedFrom.keys()])];
  }

  async readMonthPreamble(month: string): Promise<string> {
    const text = await this.io.readText(this.monthPath(month));
    return text ? parseMonthlyNote(text).preamble : "";
  }

  async removeByUids(ids: ReadonlySet<string>, originals?: Map<string, string>): Promise<number> {
    let removed = 0;
    for (const path of await this.listMonthPaths()) {
      let count = 0;
      await this.update(path, text => {
        count = 0;
        if (!text) return text;
        checkTargets(text, originals && (originals.get(path) ?? ""), ids, path);
        const parsed = sections(text);
        let out = parsed.prefix;
        for (const { raw, block, id } of parsed.blocks) {
          if (ids.has(id) && blockToEvent(block)) count++;
          else out += raw;
        }
        return out;
      });
      removed += count;
    }
    return removed;
  }
}
