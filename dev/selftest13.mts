import assert from 'node:assert/strict';
import { applyInjection, buildInjectList, injectedTaskKey, listInjectedTasks, listSkippedTasks, skipInjectedTask, restoreSkippedTask } from '../src/ui/inject.ts';
import { expandOccurrences } from '../src/core/occurrences.ts';
import type { CalendarEvent } from '../src/model/event.ts';
import Plugin from '../src/main.ts';
import { Modal } from 'obsidian';
let pass = 0;
const eq = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); pass++; };
const marker = '> [!todo]+ todo';
const note = `${marker}\n\n> [!note] 手写内容\n> 保留正文\n`;
const events: CalendarEvent[] = [
  { id: 'daily-series', title: '不想做的日程', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-20T10:00:00', isAllDay: false, repeats: { rule: 'FREQ=DAILY;COUNT=3' } },
  { id: 'another', title: '另一条日程', startsAt: '2026-10-20T11:00:00', endsAt: '2026-10-20T12:00:00', isAllDay: false },
];
const items = buildInjectList(expandOccurrences(events, new Date(2026, 9, 20), new Date(2026, 9, 21)));
const sourceEvents = JSON.stringify(events);
const original = applyInjection(note, { marker, items }).content;
const tasks = listInjectedTasks(original, marker, items);
eq('生成逐行事件身份', tasks.map(t => t.eventId), ['daily-series', 'another']);
const key = tasks[0].key;
const skipped = skipInjectedTask(original, marker, key, items);
eq('跳过后只剩另一条可见待办', listInjectedTasks(skipped, marker, items).map(t => t.eventId), ['another']);
eq('跳过记录可恢复原行', listSkippedTasks(skipped, marker)[0].row, tasks[0].row);
eq('跳过不勾选完成', skipped.includes('[x]'), false);
eq('跳过不改变日历内容', JSON.stringify(events), sourceEvents);
eq('跳过保留正文', skipped.endsWith('> [!note] 手写内容\n> 保留正文\n'), true);
eq('重复跳过不重复归档', skipInjectedTask(skipped, marker, key, items), skipped);
for (const force of [false, true]) {
  const refreshed = applyInjection(skipped, { marker, items, force, preserveChecked: true }).content;
  eq('同步/重建不会重新注入跳过的项', listInjectedTasks(refreshed, marker, items).map(t => t.eventId), ['another']);
  eq('同步/重建保留跳过记录', listSkippedTasks(refreshed, marker).length, 1);
  const restarted = applyInjection(refreshed, { marker, items }).content;
  eq('重启再次注入不变', restarted, refreshed);
  const restored = restoreSkippedTask(refreshed, marker, key);
  eq('可恢复原行', listInjectedTasks(restored, marker, items).some(t => t.row === tasks[0].row), true);
  eq('恢复后删除跳过记录', listSkippedTasks(restored, marker).length, 0);
  eq('恢复后自动注入不产生重复', listInjectedTasks(applyInjection(restored, { marker, items }).content, marker, items).length, 2);
}
const revised = items.map((it, i) => i ? it : { ...it, title: '改过标题', startTime: '14:00' });
eq('有稳定身份时改名改时刻也不会复活', listInjectedTasks(applyInjection(skipped, { marker, items: revised }).content, marker, revised).length, 1);
const tomorrow = buildInjectList(expandOccurrences(events, new Date(2026, 9, 21), new Date(2026, 9, 22)));
eq('重复日程次日照常注入', listInjectedTasks(applyInjection(note, { marker, items: tomorrow }).content, marker, tomorrow).length, 1);
const allHidden = skipInjectedTask(skipped, marker, tasks[1].key, items);
const emptyRefresh = applyInjection(allHidden, { marker, items, force: true }).content;
eq('全部跳过可以保留两条恢复记录', listSkippedTasks(emptyRefresh, marker).length, 2);
eq('全部跳过后没有可见待办', listInjectedTasks(emptyRefresh, marker, items).length, 0);
eq('全部跳过重启不回填', applyInjection(emptyRefresh, { marker, items }).content, emptyRefresh);
eq('全部跳过仍能恢复其中一条', listInjectedTasks(restoreSkippedTask(emptyRefresh, marker, key), marker, items).length, 1);
const manual = original.replace('><!--ag2-injected-->', '><!--ag2-injected-->\n>>- [ ] 手写任务');
eq('选择列表排除手写任务', listInjectedTasks(manual, marker, items).length, 2);
eq('不能按伪造键跳过手写任务', skipInjectedTask(manual, marker, '|手写任务', items), manual);
eq('右键不接管手写行', injectedTaskKey('>>- [ ] 手写任务'), undefined);
const legacy = `${marker}\n><!--ag2-injected-->\n> > - [ ] 9:00 AM 不想做的日程\n>>- [x] 手写完成\n\n正文\n`;
const legacyTask = listInjectedTasks(legacy, marker, items);
eq('历史格式只识别当前日程', legacyTask.length, 1);
const legacySkip = skipInjectedTask(legacy, marker, legacyTask[0].key, items);
eq('历史格式跳过后保留手写完成', legacySkip.includes('>>- [x] 手写完成'), true);
eq('历史格式跳过同样不会补回', listInjectedTasks(applyInjection(legacySkip, { marker, items }).content, marker, items).length, 1);
eq('历史格式也保存稳定事件身份', listSkippedTasks(legacySkip, marker)[0].eventId, 'daily-series');
eq('历史格式恢复保留原始排版', restoreSkippedTask(legacySkip, marker, legacyTask[0].key).includes('> > - [ ] 9:00 AM 不想做的日程'), true);
const checked = original.replace('[ ] 11:00', '[x] 11:00');
const checkedSkip = skipInjectedTask(checked, marker, key, items);
eq('保留其他项完成状态', applyInjection(checkedSkip, { marker, items, force: true, preserveChecked: true }).content.includes('[x] 11:00'), true);
const noCheckbox = applyInjection(note, { marker, items, format: { checkbox: false, place: false, category: false, prefix: '>' } }).content;
const noCheckboxSkip = skipInjectedTask(noCheckbox, marker, key, items);
eq('无勾选框格式也可跳过', listInjectedTasks(noCheckboxSkip, marker, items).length, 1);
for (const bad of ['%malformed', encodeURIComponent('{"key":"x","row":3}'), encodeURIComponent(JSON.stringify({key:'x',row:'>>- [ ] X\n正文'}))]) {
  const malformed = `${marker}\n> <!--ag2-skipped:${bad}-->\n\n正文\n`;
  eq('坏隐藏标记不能当成有效记录', listSkippedTasks(malformed, marker).length, 0);
  eq('坏隐藏标记不能删正文', restoreSkippedTask(malformed, marker, 'x'), malformed);
}
eq('其他区块同标记待办不可被跳过', skipInjectedTask(note + '\n' + tasks[0].row, marker, key, items), note + '\n' + tasks[0].row);
// 只跳过一个重复实例；同一天后续实例和其他日程照常保留。
const hourly: CalendarEvent = { ...events[0], repeats: { rule: 'FREQ=HOURLY;COUNT=2' } };
const hourlyItems = buildInjectList(expandOccurrences([hourly], new Date(2026, 9, 20), new Date(2026, 9, 21)));
const hourlyNote = applyInjection(note, { marker, items: hourlyItems }).content;
const hourlyHidden = skipInjectedTask(hourlyNote, marker, listInjectedTasks(hourlyNote, marker, hourlyItems)[0].key, hourlyItems);
eq('同一天重复日程只跳过一条', listInjectedTasks(applyInjection(hourlyHidden, { marker, items: hourlyItems }).content, marker, hourlyItems).length, 1);
eq('选择标题不显示隐藏元数据', listInjectedTasks(hourlyNote, marker, hourlyItems).some(t => /ag2-|<!--/.test(t.label)), false);
const cloudMerged = skipped.replace('><!--ag2-injected-->', '><!--ag2-injected-->\n' + tasks[0].row);
const mergedRefresh = applyInjection(cloudMerged, { marker, items }).content;
eq('同步合并回来的旧行会继续隐藏', listInjectedTasks(mergedRefresh, marker, items).length, 1);
eq('同步合并保留恢复记录', listSkippedTasks(mergedRefresh, marker).length, 1);
const crlf = original.replace(/\n/g, '\r\n');
const crlfHidden = skipInjectedTask(crlf, marker, key, items);
eq('Windows 换行格式可跳过', listSkippedTasks(crlfHidden, marker).length, 1);
eq('Windows 换行格式可恢复', restoreSkippedTask(crlfHidden, marker, key), crlf);
// 真实插件入口：文件处理时重新读取最新内容，保留用户同时输入的正文；不触发日历同步。
{
  const plugin: any = Object.create(Plugin.prototype);
  let current = original, syncs = 0, processes = 0;
  const file = { name: '2026-10-20.md', path: 'Daily/2026-10-20.md' };
  Object.assign(plugin, { settings: { injectMarker: marker, injectFolder: 'Daily' },
    app: { workspace: { getActiveFile: () => file }, vault: { read: async () => current, process: async (_f: unknown, update: (s:string)=>string) => { processes++; current = update(current + '\n同时输入的正文'); } } },
    loadEvents: async () => events, syncNow: async () => { syncs++; },
  });
  await plugin.changeInjectedTask('skip', key);
  eq('真实入口隐藏待办', listInjectedTasks(current, marker, items).length, 1);
  eq('真实入口保留并发编辑', current.includes('同时输入的正文'), true);
  eq('真实入口不触发日历写入', syncs, 0);
  (Modal as any).choiceIndex = 0;
  await plugin.changeInjectedTask('restore');
  eq('恢复命令可选择并恢复', listSkippedTasks(current, marker).length, 0);
  (Modal as any).choiceIndex = undefined;
  await plugin.changeInjectedTask('skip');
  eq('关闭选择窗口不会修改日记', processes, 2);
  await plugin.changeInjectedTask('skip', key, { name: '2026-10-20.md', path: 'Other/2026-10-20.md' });
  eq('范围外日记不修改', processes, 2);
  await plugin.changeInjectedTask('skip', key, { name: '普通笔记.md', path: 'Daily/普通笔记.md' });
  eq('普通笔记不修改', processes, 2);
}
// 编辑缓冲区比磁盘新：跳过/恢复必须保留未保存输入，且使用一次最小编辑。
{
  const plugin: any = Object.create(Plugin.prototype);
  const file = { name: '2026-10-20.md', path: 'Daily/2026-10-20.md' };
  const disk = original; let current = original + '\n尚未保存的输入'; let writes = 0, edits = 0, lastInserted = '';
  const offsetToPos = (offset: number) => { const before = current.slice(0, offset).split('\n'); return { line: before.length - 1, ch: before.at(-1)!.length }; };
  const posToOffset = (pos: {line:number;ch:number}) => current.split('\n').slice(0,pos.line).reduce((n,line)=>n+line.length+1,0)+pos.ch;
  const editor = { getValue: () => current, offsetToPos,
    replaceRange: (text: string, from: any, to: any) => { const a=posToOffset(from),b=posToOffset(to); current=current.slice(0,a)+text+current.slice(b); edits++;lastInserted=text; } };
  Object.assign(plugin, { settings: { injectMarker: marker, injectFolder: 'Daily' },
    app: { workspace: { getActiveFile: () => file, getActiveViewOfType: () => ({ file, editor, getMode: ()=>'source' }) },
      vault: { read: async () => disk, process: async () => { writes++; } } },
    loadEvents: async () => { current += '\n加载期间继续输入'; return events; },
  });
  await plugin.changeInjectedTask('skip', key);
  eq('未保存输入不会被旧磁盘内容覆盖', current.includes('尚未保存的输入'), true);
  eq('异步加载期间的输入也保留', current.includes('加载期间继续输入'), true);
  eq('编辑器中确实隐藏选中日程', listInjectedTasks(current, marker, items).length, 1);
  eq('直接改编辑缓冲区而不覆盖磁盘', writes, 0);
  eq('跳过只产生一次原生编辑', edits, 1);
  eq('最小替换不会重写正文', lastInserted.includes('尚未保存的输入'), false);
  plugin.loadEvents = async () => { throw new Error('月度日程暂不可读'); };
  await plugin.changeInjectedTask('restore', key);
  eq('恢复不依赖月度日程可读取', listSkippedTasks(current, marker).length, 0);
  eq('恢复保留原先未保存内容', current.includes('尚未保存的输入') && current.includes('加载期间继续输入'), true);
  eq('恢复仍只执行一条原生编辑', edits, 2);
  eq('恢复不会误改磁盘', writes, 0);
}
console.log(`日记跳过与恢复回归:${pass} 通过,0 失败`);
