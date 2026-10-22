import type { CalendarEvent } from "./event";

/**
 * v2 内容指纹:对"会写回服务器的字段"做规范化 JSON 后取 SHA-256。
 * 与 v1 的 FNV-1a 32 位完全不同:碰撞域从 2^32 升到 2^256,且对字段增删敏感。
 * 同步元数据(id/账本状态)永不参与指纹——刷新元数据不会被误判为本地编辑。
 */
export async function contentFingerprint(ev: CalendarEvent): Promise<string> {
  const canonical = {
    t: ev.title ?? "",
    s: ev.startsAt ?? "",
    e: ev.endsAt ?? "",
    d: ev.isAllDay === true ? 1 : 0,
    p: ev.place ?? "",
    n: ev.notes ?? "",
    c: ev.category ?? "",
    o: ev.organizer ?? "",
    a: [...(ev.attendees ?? [])].sort(),
    u: ev.url ?? "",
    r: ev.repeats?.rule ?? "",
    st: ev.status ?? "",
    ...(ev.recurrenceId ? { ri: ev.recurrenceId } : {}),
    ...(ev.recurrenceOverrides?.length ? { overrides: await Promise.all([...ev.recurrenceOverrides]
      .sort((a, b) => (a.recurrenceId ?? "").localeCompare(b.recurrenceId ?? ""))
      .map(async (o) => [o.recurrenceId, await contentFingerprint(o)])) } : {}),
    x: [...(ev.skippedDates ?? [])].sort(),
    m: [...(ev.reminderMinutes ?? [])].sort((a, b) => a - b),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 32); // 128 位十六进制表示,足够防碰撞且账本可读
}
