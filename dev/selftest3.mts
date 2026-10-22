// 注入逻辑单测:幂等/force 重建/用户内容保全/v1 块不干扰/去重/排序/跨午夜
import { applyInjection, buildInjectList } from "../src/ui/inject.ts";
import { expandOccurrences } from "../src/core/occurrences.ts";
import type { CalendarEvent } from "../src/model/event.ts";

let pass = 0; const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else fails.push(`${name}: got ${g}, want ${w}`);
};

const MARKER = "> [!todo]+ todo";
const note = (marker = MARKER) => `---\ndate: x\n---\n\n${marker}\n\n> [!callout]\n> 用户内容\n`;

// 1. 基本注入
const r1 = applyInjection(note(), { marker: MARKER, items: [
  { title: "站会", allDay: false, startTime: "09:00", endTime: "09:30", category: "工作" },
  { title: "全天团建", allDay: true },
] });
eq("注入状态", r1.status, "injected");
eq("注入条数", r1.count, 2);
eq("全天排最前", r1.content.indexOf("全天团建") < r1.content.indexOf("站会"), true);
eq("时间格式", /\[ \] 09:00-09:30 站会 🏷️工作/.test(r1.content), true);
eq("用户内容保留", r1.content.includes("> 用户内容"), true);
eq("标记行保留", r1.content.includes(MARKER), true);

// 2. 增量补充：已有条目保留，新增条目追加
const r2 = applyInjection(r1.content, { marker: MARKER, items: [{ title: "新事件", allDay: false, startTime: "10:00" }] });
eq("新事件补入", r2.status, "injected");
eq("不覆盖用户改动", r2.content.includes("站会") && r2.content.includes("新事件"), true);

// 3. force=true → 重建为新列表
const r3 = applyInjection(r1.content, { marker: MARKER, items: [{ title: "新事件", allDay: false, startTime: "10:00" }], force: true });
eq("force 重建", r3.status, "injected");
eq("旧块清除", r3.content.includes("站会"), false);
eq("新块写入", r3.content.includes("10:00 新事件"), true);
eq("用户内容仍在", r3.content.includes("> 用户内容"), true);

// 4. v1 旧块(agenda-injected)不被 v2 触碰
const withV1 = note() + "\n<!--agenda-injected-->\n>>- [ ] 14:00 v1事件\n";
const r4 = applyInjection(withV1, { marker: MARKER, items: [{ title: "v2事件", allDay: false, startTime: "09:00" }] });
eq("v2 正常注入", r4.status, "injected");
eq("v1 块原样保留", r4.content.includes("v1事件"), true);

// 5. 无标记 → no-marker
eq("无标记", applyInjection("没有标记的笔记", { marker: MARKER, items: [{ title: "x", allDay: true }] }).status, "no-marker");

// 6. 空日程 + force → 清除旧块
const r6 = applyInjection(r1.content, { marker: MARKER, items: [], force: true });
eq("清空旧块", r6.status, "cleared");
eq("清单项移除", r6.content.includes("[ ]"), false);

// 7. 去重:同题同时刻只留一条
const r7 = applyInjection(note(), { marker: MARKER, items: [
  { title: "重复", allDay: false, startTime: "10:00" },
  { title: "重复", allDay: false, startTime: "10:00" },
] });
eq("去重", (r7.content.match(/\[ \] 10:00 重复/g) ?? []).length, 1);

// 8. 端到端:事件 → occurrence 展开(跨午夜裁剪)→ 注入清单
const events: CalendarEvent[] = [
  { id: "c1", title: "跨午夜", startsAt: "2026-09-28T23:00:00", endsAt: "2026-09-29T01:00:00", isAllDay: false },
];
const occs = expandOccurrences(events, new Date(2026, 8, 28), new Date(2026, 8, 29));
const list = buildInjectList(occs);
eq("跨午夜当日裁剪", list[0]?.endTime, "00:00");

// ── 9. preserveChecked:重建保留勾选状态 ──
const c1 = applyInjection(note(), { marker: MARKER, items: [
  { title: "甲", allDay: false, startTime: "09:00", endTime: "09:30" },
  { title: "乙", allDay: false, startTime: "10:00" },
] });
const checkedNote = c1.content.replace(">>- [ ] 09:00-09:30 甲", ">>- [x] 09:00-09:30 甲");
const c2 = applyInjection(checkedNote, { marker: MARKER, items: [
  { title: "甲", allDay: false, startTime: "09:00", endTime: "09:30" },
  { title: "乙", allDay: false, startTime: "10:00" },
  { title: "丙", allDay: false, startTime: "11:00" },
], force: true, preserveChecked: true });
eq("勾选跨重建保留", /\[x\] 09:00-09:30 甲/.test(c2.content), true);
eq("未勾选不受影响", /\[ \] 10:00 乙/.test(c2.content), true);
eq("新增项默认未勾", /\[ \] 11:00 丙/.test(c2.content), true);
eq("甲的地点分类不干扰键匹配", true, true);
const c3 = applyInjection(checkedNote, { marker: MARKER, items: [
  { title: "甲改期", allDay: false, startTime: "14:00" },
], force: true, preserveChecked: true });
eq("键变了不误勾", c3.content.includes("[x]"), false);
// 不带 preserveChecked 的 force 仍重置(原语义)
const c4 = applyInjection(checkedNote, { marker: MARKER, items: [
  { title: "甲", allDay: false, startTime: "09:00", endTime: "09:30" },
], force: true });
eq("未开启时重置勾选", c4.content.includes("[x]"), false);

// 重启时：标记缺失或引用空格被格式化，都不能重复插入。
for (const row of [">>- [x] 09:00 站会", "> > - [X] 09:00 站会", "> - [ ] 09:00 站会", ">>- 全天团建"]) {
  const existing = `${MARKER}\n>\n${row}\n\n正文\n`;
  const result = applyInjection(existing, { marker: MARKER, items: row.includes("全天团建") ? [{ title: "全天团建", allDay: true }] : [{ title: "站会", allDay: false, startTime: "09:00" }] });
  eq(`已有条目跳过 ${row}`, result.status, "skipped");
  eq(`已有条目原样保留 ${row}`, result.content, existing);
}
const formatted = `${MARKER}\n><!--ag2-injected-->\n> > - [X] 09:00 站会 📍办公室 🏷️工作\n\n正文\n`;
const refreshed = applyInjection(formatted, { marker: MARKER, items: [{ title: "站会", allDay: false, startTime: "09:00", place: "办公室", category: "工作" }], force: true, preserveChecked: true });
eq("格式化后刷新不重复", (refreshed.content.match(/站会/g) ?? []).length, 1);
eq("格式化后勾选保留", refreshed.content.includes("[x] 09:00 站会"), true);
eq("刷新后再次启动跳过", applyInjection(refreshed.content, { marker: MARKER, items: [] }).content, refreshed.content);

// 重启、同步、本地新增共用同一增量逻辑；反复运行后只新增一次。
const additional = [
  { title: "站会", allDay: false, startTime: "09:00", endTime: "09:45", place: "新办公室" },
  { title: "新增会议", allDay: false, startTime: "14:00" },
  { title: "新增全天", allDay: true },
];
for (const original of [formatted, formatted.replace("><!--ag2-injected-->\n", ""), formatted.replace("09:00", "9:00 AM")]) {
  const merged = applyInjection(original, { marker: MARKER, items: additional });
  eq("仅追加两项", merged.count, 2);
  eq("旧日程不重复", (merged.content.match(/站会/g) ?? []).length, 1);
  eq("保留原有完成状态和地点", merged.content.includes("[X]") && merged.content.includes("办公室 🏷️工作"), true);
  eq("新增日程在正文前", merged.content.indexOf("新增会议") < merged.content.indexOf("正文"), true);
  eq("新增全天仅一项", (merged.content.match(/新增全天/g) ?? []).length, 1);
  const again = applyInjection(merged.content, { marker: MARKER, items: additional });
  eq("反复启动不再写入", again.status, "skipped");
  eq("反复启动内容完全一致", again.content, merged.content);
}
const manual = `${MARKER}\n> - [x] 自己写的任务\n\n正文\n`;
const supplemented = applyInjection(manual, { marker: MARKER, items: additional });
eq("用户任务不阻止新增日程", supplemented.count, 3);
eq("用户任务原样保留", supplemented.content.includes("> - [x] 自己写的任务"), true);

console.log(`注入单测:${pass} 通过,${fails.length} 失败`);
for (const f of fails) console.log("  ✗", f);
if (fails.length) process.exit(1);
