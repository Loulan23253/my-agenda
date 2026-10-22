import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
(globalThis as any).DOMParser = new JSDOM().window.DOMParser;
import { SyncEngine, type CalendarRoute } from '../src/sync/engine.ts';
import { MonthlyNoteStore } from '../src/data/note-store.ts';
import type { SyncJournal } from '../src/data/journal.ts';
import type { CalendarEvent } from '../src/model/event.ts';
import type { Http } from '../src/sync/dav.ts';
import { contentFingerprint } from '../src/model/content-fingerprint.ts';
import { buildSingleIcs } from '../src/sync/ics-build.ts';
import { AgendaPanelView } from '../src/ui/panel.ts';
import Plugin from '../src/main.ts';
import { Modal } from 'obsidian';
import { expandOccurrences } from '../src/core/occurrences.ts';
let pass = 0;
const eq = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); pass++; };
const route: CalendarRoute = { id: 'c', url: 'https://example.invalid/c/', name: '测试', category: '', auth: { user: 'u', pass: 'p' } };
const base: CalendarEvent = { id: 'e', title: '原始', startsAt: '2026-10-18T09:00:00', endsAt: '2026-10-18T10:00:00', isAllDay: false };
const remote = { ...base, title: '远端更新' };
const response = (text: string, status = 207) => ({ text, status, headers: {} });
const xml = (items: { id: string; ics?: string; etag?: string; deleted?: boolean }[], token = '') =>
  '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' + items.map((item) =>
    `<d:response><d:href>${route.url}${item.id}.ics</d:href>` + (item.deleted ? '<d:status>HTTP/1.1 404 Not Found</d:status>' :
      `<d:propstat><d:prop><d:getetag>${item.etag ?? 'v2'}</d:getetag>${item.ics === undefined ? '' : `<c:calendar-data><![CDATA[${item.ics}]]></c:calendar-data>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`) + '</d:response>').join('') +
  (token ? `<d:sync-token>${token}</d:sync-token>` : '') + '</d:multistatus>';
async function fixture(events: CalendarEvent[] = [base], token?: string) {
  const files = new Map<string, string>();
  let writes = 0;
  const notes = new MonthlyNoteStore({
    async readText(p) { return files.get(p) ?? null; }, async writeText(p, c) { files.set(p, c); writes++; },
    async listFiles() { return [...files.keys()]; }, async ensureDir() {}, async remove(p) { files.delete(p); writes++; },
  }, 'Agenda');
  await notes.writeMonth('2026-10', events);
  writes = 0;
  const journal: SyncJournal = { version: 2, calendars: token ? { c: { url: route.url, syncToken: token } } : {}, events: {} };
  for (const ev of events) journal.events[ev.id] = { calendarId: 'c', href: route.url + ev.id + '.ics', etag: 'v1', state: 'synced', pushedFingerprint: await contentFingerprint(ev) };
  const requests: any[] = [];
  const notifications: string[] = [];
  let choice: 'mine' | 'theirs' | null = null;
  const engine = (http: Http) => new SyncEngine({ notes, journal, routes: [route],
    http: async (opts) => { requests.push(opts); return http(opts); }, saveJournal: async () => {},
    askConflict: async () => choice, notify: (message) => notifications.push(message), sleep: async () => {},
  });
  return { notes, files, journal, requests, notifications, engine, writes: () => writes, choose: (value: typeof choice) => { choice = value; } };
}
// 服务器返回了资源，但资源内容不完整，不得当作缺席而删除本地数据。
const broken = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e\r\nSUMMARY:缺时间\r\nEND:VEVENT\r\nEND:VCALENDAR';
for (const text of [xml([{ id: 'e', ics: broken }]), xml([{ id: 'e', ics: '' }]), xml([{ id: 'e' }])]) {
  const f = await fixture();
  const before = JSON.stringify(f.journal);
  await assert.rejects(f.engine(async () => response(text)).run(), /解析失败|内容不完整/); pass++;
  eq('坏资源不写本地文件', f.writes(), 0);
  eq('坏资源不改账本', JSON.stringify(f.journal), before);
  eq('坏资源保留旧事件', (await f.notes.loadAll()).events[0].title, '原始');
}
// iCloud 在 VEVENT 查询中附带日历集合；集合没有 calendar-data 是正常的。
const collection = `<d:response><d:href>${route.url}</d:href><d:propstat><d:prop><d:getetag>collection</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><c:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`;
const withCollection = (text: string) => text.replace('</d:multistatus>', collection + '</d:multistatus>');
for (const incremental of [false, true]) {
  const f = await fixture([base], incremental ? 'old' : undefined);
  await f.engine(async (opts) => response(withCollection(opts.body?.includes('sync-collection') ? xml([{ id: 'e' }], 'new') : xml([{ id: 'e', ics: buildSingleIcs(remote) }])))).run();
  eq('iCloud 集合元数据不阻止事件同步', (await f.notes.loadAll()).events[0].title, '远端更新');
  eq('集合自身不会当作事件保存', (await f.notes.loadAll()).events.length, 1);
  if (incremental) eq('集合元数据不阻止推进游标', f.journal.calendars.c.syncToken, 'new');
}
{
  const f = await fixture();
  await f.engine(async () => response(withCollection(xml([])))).run();
  eq('只有集合元数据的空日历可以正常处理', (await f.notes.loadAll()).events.length, 0);
}
{
  const f = await fixture();
  await assert.rejects(f.engine(async () => response(withCollection(xml([{ id: 'e', ics: broken }])))).run(), /解析失败/); pass++;
  eq('忽略集合后仍保护真正的坏事件', (await f.notes.loadAll()).events[0].title, '原始');
  eq('真正的坏事件仍不会写文件', f.writes(), 0);
}
// 真正的空日历仍应按服务器删除处理。
{
  const f = await fixture(); await f.engine(async () => response(xml([]))).run();
  eq('完整空响应允许跟随服务器删除', (await f.notes.loadAll()).events.length, 0);
}
// 取消冲突既不能覆盖本地内容，也不能吞掉远端变更的同步令牌。
for (const incremental of [false, true]) {
  const f = await fixture([{ ...base, title: '本地修改' }], incremental ? 'old' : undefined);
  f.journal.events.e.pushedFingerprint = await contentFingerprint(base);
  const before = JSON.stringify(f.journal);
  const http: Http = async (opts) => response(opts.body?.includes('sync-collection') ? xml([{ id: 'e' }], 'new') : xml([{ id: 'e', ics: buildSingleIcs(remote) }]));
  await f.engine(http).run();
  eq('关闭冲突弹窗保留本地修改', (await f.notes.loadAll()).events[0].title, '本地修改');
  eq('关闭冲突弹窗不改指纹和令牌', JSON.stringify(f.journal), before);
  eq('关闭冲突弹窗不执行 PUT 或 DELETE', f.requests.filter((r) => ['PUT', 'DELETE'].includes(r.method)).length, 0);
  f.choose('theirs'); await f.engine(http).run();
  eq('下次仍能处理冲突', (await f.notes.loadAll()).events[0].title, '远端更新');
}
// multiget 部分返回：必须补取遗漏资源，失败时不准提交一半的结果。
for (const getOk of [true, false]) {
  const second = { ...base, id: 'e2' };
  const f = await fixture([base, second], 'old');
  const before = JSON.stringify(f.journal);
  const run = f.engine(async (opts) => {
    if (opts.body?.includes('sync-collection')) return response(xml([{ id: 'e' }, { id: 'e2' }], 'new'));
    if (opts.body?.includes('calendar-multiget')) return response(xml([{ id: 'e', ics: buildSingleIcs(remote) }]));
    if (opts.method === 'GET') return getOk ? response(buildSingleIcs({ ...second, title: '第二条更新' }), 200) : response('fail', 503);
    return response('fail', 500);
  }).run();
  if (getOk) {
    await run;
    eq('遗漏资源被 GET 补取', f.requests.filter((r) => r.method === 'GET').map((r) => r.url), [route.url + 'e2.ics']);
    eq('两条修改都写入后推进令牌', f.journal.calendars.c.syncToken, 'new');
    eq('两条修改均落盘', (await f.notes.loadAll()).events.map((e) => e.title), ['远端更新', '第二条更新']);
  } else {
    await assert.rejects(run, /拉取失败/); pass++;
    eq('补取失败保留原令牌和账本', JSON.stringify(f.journal), before);
    eq('补取和全量均失败时不写任何文件', f.writes(), 0);
    eq('部分数据不覆盖原内容', (await f.notes.loadAll()).events.map((e) => e.title), ['原始', '原始']);
  }
}
// 没有变化或只有删除的增量响应也可以安全推进令牌。
for (const deleted of [false, true]) {
  const f = await fixture([base], 'old');
  await f.engine(async () => response(xml(deleted ? [{ id: 'e', deleted: true }] : [], 'new'))).run();
  eq('完整的空/删除增量可以推进令牌', f.journal.calendars.c.syncToken, 'new');
  eq('空/删除增量正确保留或移除事件', (await f.notes.loadAll()).events.length, deleted ? 0 : 1);
}
// 真实面板选择“仅此一次”，再通过真实插件保存，不能复制系列的其他例外。
{
  const override: CalendarEvent = { ...base, title: '现有例外', startsAt: '2026-10-19T14:00:00', endsAt: '2026-10-19T15:00:00', recurrenceId: '2026-10-19T09:00:00' };
  const master: CalendarEvent = { ...base, repeats: { rule: 'FREQ=DAILY;COUNT=3' }, recurrenceOverrides: [override] };
  const f = await fixture([master]);
  let captured: CalendarEvent | undefined;
  let callback: unknown;
  const panel: any = Object.create(AgendaPanelView.prototype);
  panel.app = {};
  panel.ctx = { openEditor(e: CalendarEvent, _d: string, _s: unknown, _e: unknown, afterSave: unknown) { captured = e; callback = afterSave; } };
  (Modal as any).choiceIndex = 1;
  await panel.openOccurrenceEditor({ event: master, start: base.startsAt, end: base.endsAt });
  eq('单次编辑保持主系列 UID', captured?.id, master.id);
  eq('单次编辑有原实例身份', captured?.recurrenceId, base.startsAt);
  eq('单次编辑不复制其他例外', captured?.recurrenceOverrides, undefined);
  eq('单次编辑不另排第二次保存', callback, undefined);
  const plugin: any = Object.create(Plugin.prototype);
  Object.assign(plugin, { notes: f.notes, journal: f.journal, settings: { provider: 'none', injectEnabled: false }, refreshPanels() {} });
  await plugin.saveEventsList([{ ...captured!, title: '仅今天修改' }]);
  const saved = (await f.notes.loadAll()).events;
  eq('保存后仍只有一个系列', saved.length, 1);
  eq('保存后有两个互不覆盖的例外', saved[0].recurrenceOverrides?.length, 2);
  eq('今天和已有例外都正确显示', expandOccurrences(saved, new Date(2026, 9, 18), new Date(2026, 9, 20)).map((o) => [o.event.title, o.start]), [
    ['仅今天修改', '2026-10-18T09:00:00'], ['现有例外', '2026-10-19T14:00:00'],
  ]);
  (Modal as any).choiceIndex = undefined;
}
console.log(`同步保护与单次编辑回归:${pass} 通过,0 失败`);
