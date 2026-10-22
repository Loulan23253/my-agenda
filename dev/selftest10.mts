import assert from 'node:assert/strict';
import { applyInjection } from '../src/ui/inject.ts';
import { expandOccurrences } from '../src/core/occurrences.ts';
import { dueReminders } from '../src/kernel/reminders.ts';
import { parseIcsToEvents } from '../src/sync/ical.ts';
import { buildSingleIcs } from '../src/sync/ics-build.ts';
import { serializeBlock, parseMonthlyNote, blockToEvent } from '../src/data/note-format.ts';
import { contentFingerprint } from '../src/model/content-fingerprint.ts';
import type { CalendarEvent } from '../src/model/event.ts';
let pass = 0;
function eq(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); pass++; }
const marker = '> [!todo]+ todo';
const items = [{ title: '站会', allDay: false, startTime: '09:00' }];
const initial = applyInjection(marker + '\n', { marker, items }).content;
for (const separator of ['', '\n', '>\n']) {
  const manual = `${initial}${separator}>>- [x] 手写买菜\n\n正文\n`;
  const updated = applyInjection(manual, { marker, items: [{ ...items[0], title: '新会议' }], force: true });
  eq('强制重建保留手写待办', updated.content.includes('>>- [x] 手写买菜'), true);
  eq('强制重建清理旧托管条目', updated.content.includes('站会'), false);
  eq('保留正文', updated.content.includes('正文'), true);
  const cleared = applyInjection(manual, { marker, items: [], force: true });
  eq('空日程清理保留手写待办', cleared.content.includes('>>- [x] 手写买菜'), true);
  eq('空日程清理删除托管日程', cleared.content.includes('站会'), false);
}
const legacy = `${marker}\n><!--ag2-injected-->\n>>- [x] 09:00 站会\n\n>>- [ ] 手写买菜\n`;
const legacyUpdated = applyInjection(legacy, { marker, items, force: true, preserveChecked: true });
eq('旧格式手写待办保留', legacyUpdated.content.includes('手写买菜'), true);
eq('旧格式相同会议不重复', (legacyUpdated.content.match(/站会/g) ?? []).length, 1);
eq('旧格式完成状态保留', legacyUpdated.content.includes('[x] 09:00 站会'), true);
eq('自动重复执行无修改', applyInjection(initial, { marker, items }).content, initial);
const manualOnly = `${marker}\n>>- [ ] 手写任务\n`;
eq('无隐藏标记强制注入保留手写任务', applyInjection(manualOnly, { marker, items, force: true }).content.includes('手写任务'), true);

const ev: CalendarEvent = { id: 'r', title: '跨午夜', startsAt: '2026-10-14T23:00:00', endsAt: '2026-10-15T01:00:00', isAllDay: false, repeats: { rule: 'FREQ=DAILY;COUNT=3' }, reminderMinutes: [0] };
const from = new Date(2026, 9, 15), to = new Date(2026, 9, 16);
const overnight = expandOccurrences([ev], from, to);
eq('重复日程含前一天延续部分', overnight.map((o) => [o.start, o.end]), [['2026-10-15T00:00:00', '2026-10-15T01:00:00'], ['2026-10-15T23:00:00', '2026-10-16T00:00:00']]);
eq('显示切片保留原事件身份', overnight.every((o) => o.event === ev), true);
eq('跨午夜不制造午夜提醒', dueReminders([ev], new Date(2026, 9, 15, 0, 0, 30)).length, 0);
eq('重复日程正常提醒', dueReminders([ev], new Date(2026, 9, 15, 23, 0, 30)).length, 1);
eq('已取消重复日程不提醒', dueReminders([{ ...ev, status: 'cancelled' }], new Date(2026, 9, 15, 23, 0, 30)).length, 0);
eq('已取消普通日程不提醒', dueReminders([{ ...ev, repeats: undefined, status: 'cancelled' }], new Date(2026, 9, 14, 23, 0, 30)).length, 0);
const multi = { ...ev, startsAt: '2026-10-14', endsAt: '2026-10-16', isAllDay: true, repeats: { rule: 'FREQ=WEEKLY;COUNT=2' } };
eq('重复全天跨日延续', expandOccurrences([multi], from, to).map((o) => o.start), ['2026-10-15']);

const wrap = (parts: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...parts, 'END:VCALENDAR'].join('\r\n');
const master = ['BEGIN:VEVENT', 'UID:series', 'DTSTART:20261015T090000', 'DTEND:20261015T100000', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:日常会议', 'END:VEVENT'];
const override = ['BEGIN:VEVENT', 'UID:series', 'RECURRENCE-ID:20261016T090000', 'DTSTART:20261016T140000', 'DTEND:20261016T150000', 'SUMMARY:改到下午', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT'];
const cancellation = ['BEGIN:VEVENT', 'UID:series', 'RECURRENCE-ID:20261017T090000', 'DTSTART:20261017T090000', 'DTEND:20261017T100000', 'STATUS:CANCELLED', 'SUMMARY:取消会议', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT'];
const day16 = [new Date(2026, 9, 16), new Date(2026, 9, 17)] as const;
for (const parts of [[...master, ...override, ...cancellation], [...override, ...cancellation, ...master]]) {
  const parsed = parseIcsToEvents(wrap(parts));
  eq('同 UID 保存为单一同步资源', parsed.length, 1);
  eq('全部例外被保留', parsed[0].recurrenceOverrides?.length, 2);
  const stored = blockToEvent(parseMonthlyNote(serializeBlock(parsed[0])).blocks[0])!;
  const returned = parseIcsToEvents(buildSingleIcs(stored))[0];
  for (const version of [parsed[0], stored, returned]) {
    eq('导入/落盘/导出均在下午显示例外', expandOccurrences([version], ...day16).map((o) => [o.event.title, o.start]), [['改到下午', '2026-10-16T14:00:00']]);
    eq('例外的原实例身份保留', version.recurrenceOverrides?.[0].recurrenceId, '2026-10-16T09:00:00');
    eq('单次取消不影响其他日程', expandOccurrences([version], new Date(2026, 9, 15), new Date(2026, 9, 16)).length, 1);
    eq('取消的例外不提醒', dueReminders([version], new Date(2026, 9, 17, 9, 0, 30)).length, 0);
    eq('例外按修改后的时间提醒', dueReminders([version], new Date(2026, 9, 16, 13, 50, 30)).length, 1);
  }
  eq('例外修改参与指纹', await contentFingerprint(parsed[0]) === await contentFingerprint({ ...parsed[0], recurrenceOverrides: parsed[0].recurrenceOverrides!.map((o) => ({ ...o, title: o.title + '改' })) }), false);
  eq('笔记往返指纹稳定', await contentFingerprint(parsed[0]), await contentFingerprint(stored));
  eq('ICS往返指纹稳定', await contentFingerprint(parsed[0]), await contentFingerprint(returned));
}
const moved = parseIcsToEvents(wrap([...master, ...override]))[0];
moved.recurrenceOverrides![0].startsAt = '2026-11-01T14:00:00';
moved.recurrenceOverrides![0].endsAt = '2026-11-01T15:00:00';
eq('移走后原日期不再出现', expandOccurrences([moved], ...day16).length, 0);
eq('例外移到系列结束以后仍显示', expandOccurrences([moved], new Date(2026, 10, 1), new Date(2026, 10, 2)).length, 1);
const orphan = parseIcsToEvents(wrap([...override, ...cancellation]));
eq('无主系列保留所有例外', orphan[0].recurrenceOverrides?.length, 2);
eq('无主系列不制造额外普通事件', (buildSingleIcs(orphan[0]).match(/BEGIN:VEVENT/g) ?? []).length, 2);
eq('无主系列往返保留全部例外', parseIcsToEvents(buildSingleIcs(orphan[0]))[0].recurrenceOverrides?.length, 2);
const zoned = wrap([...master, ...override]).replaceAll('DTSTART:20261015T090000', 'DTSTART;TZID=Asia/Shanghai:20261015T090000').replaceAll('RECURRENCE-ID:20261016T090000', 'RECURRENCE-ID:20261016T010000Z');
eq('UTC RECURRENCE-ID 与本地起点正确匹配', expandOccurrences(parseIcsToEvents(zoned), ...day16).map((o) => o.start), ['2026-10-16T14:00:00']);
const wholeCancelled = parseIcsToEvents(wrap([...master, ...override]))[0];
wholeCancelled.status = 'cancelled';
eq('取消整个系列也停止例外提醒', dueReminders([wholeCancelled], new Date(2026, 9, 16, 13, 50, 30)).length, 0);
const diagnostics = { skipped: 0 };
parseIcsToEvents(wrap(['BEGIN:VEVENT', 'UID:broken', 'SUMMARY:缺少时间', 'END:VEVENT']), 'ics', diagnostics);
eq('无法解析的订阅事件被报告', diagnostics.skipped, 1);
console.log(`修复回归:${pass} 通过,0 失败`);
