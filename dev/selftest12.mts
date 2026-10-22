import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
(globalThis as any).DOMParser = new JSDOM().window.DOMParser;
import ICAL from 'ical.js';
import { SyncEngine, type CalendarRoute } from '../src/sync/engine.ts';
import { MonthlyNoteStore } from '../src/data/note-store.ts';
import { contentFingerprint } from '../src/model/content-fingerprint.ts';
import { buildSingleIcs } from '../src/sync/ics-build.ts';
import type { CalendarEvent } from '../src/model/event.ts';
import type { SyncJournal } from '../src/data/journal.ts';
import type { Http } from '../src/sync/dav.ts';
let pass = 0;
const eq = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); pass++; };
const route: CalendarRoute = { id: 'class', url: 'https://example.invalid/class/', category: '上课', name: '上课', auth: { user: 'u', pass: 'p' } };
const personal = { ...route, id: 'personal', url: 'https://example.invalid/personal/', category: '个人', name: '个人' };
const ev: CalendarEvent = { id: 'test', title: '本地日程', startsAt: '2026-10-19T09:00:00', endsAt: '2026-10-19T10:00:00', isAllDay: false, category: '上课' };
const empty = '<d:multistatus xmlns:d="DAV:"/>';
const ok = (text: string, status = 207, headers: Record<string, string> = {}) => ({ text, status, headers });
const resource = (event: CalendarEvent, url: string, etag: string) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${url}</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag><c:calendar-data><![CDATA[${buildSingleIcs(event)}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
async function fixture(local: CalendarEvent, tracked = false, routes: CalendarRoute[] = [route]) {
  const files = new Map<string, string>();
  const notes = new MonthlyNoteStore({ async readText(p) { return files.get(p) ?? null; }, async writeText(p, t) { files.set(p, t); }, async listFiles() { return [...files.keys()]; }, async remove(p) { files.delete(p); }, async ensureDir() {} }, 'Agenda');
  await notes.writeMonth('2026-10', [local]);
  const journal: SyncJournal = { version: 2, events: {}, calendars: {} };
  if (tracked) {
    journal.events[local.id] = { calendarId: route.id, href: route.url + 'remote.ics', etag: 'old-etag', state: 'synced', pushedFingerprint: await contentFingerprint({ ...local, title: '原来标题' }) };
    journal.calendars[route.id] = { url: route.url, syncToken: 'old-token' };
  }
  const requests: any[] = [], messages: string[] = [];
  return { notes, journal, requests, messages, run: (http: Http, choice: 'mine' | 'theirs' | null = null) => new SyncEngine({ notes, journal, routes, saveJournal: async () => {}, askConflict: async () => choice,
    http: async (o) => { requests.push(o); return http(o); }, notify: (m) => messages.push(m), sleep: async () => {} }).run() };
}
{
  const series = { ...ev, repeats: { rule: 'FREQ=DAILY;COUNT=3' }, recurrenceOverrides: [{ ...ev, startsAt: '2026-10-20T14:00:00', recurrenceId: '2026-10-20T09:00:00' }] };
  const calendar = new ICAL.Component(ICAL.parse(buildSingleIcs(series)));
  eq('DTSTAMP 不应写在 VCALENDAR 上', calendar.hasProperty('dtstamp'), false);
  const events = calendar.getAllSubcomponents('vevent');
  eq('主系列和例外均导出', events.length, 2);
  eq('每条 VEVENT 都有自己的 DTSTAMP', events.every((e) => e.hasProperty('dtstamp')), true);
  eq('所有时间戳均为 UTC', events.every((e) => String(e.getFirstPropertyValue('dtstamp')).endsWith('Z')), true);
}
{
  const f = await fixture({ ...ev, category: 'Calendar' });
  const summary = await f.run(async () => ok(empty));
  eq('旧分类不匹配不能写入首个日历', f.requests.filter((r) => r.method === 'PUT').length, 0);
  eq('未匹配分类被明确报告', summary.unmapped, 1);
  eq('未匹配日程保留本地', (await f.notes.loadAll()).events[0].category, 'Calendar');
  eq('不伪造已上传账本', Object.keys(f.journal.events).length, 0);
}
{
  const f = await fixture({ ...ev, category: '个人' }, false, [route, personal]);
  const summary = await f.run(async (o) => o.method === 'PUT' ? ok('', 201, { etag: 'created' }) : ok(empty));
  const put = f.requests.find((r) => r.method === 'PUT');
  eq('明确分类匹配正确日历', put.url, personal.url + ev.id + '.ics');
  eq('新建使用 If-None-Match 防覆盖', put.headers['If-None-Match'], '*');
  eq('新建不带 If-Match', put.headers['If-Match'], undefined);
  eq('成功创建计数', summary.created, 1);
}
{
  const f = await fixture(ev);
  const summary = await f.run(async (o) => o.method === 'PUT' ? ok('', 412) : o.method === 'GET' ? ok('', 404) : ok(empty));
  eq('新建 412 且 GET 404 明确计为失败', summary.failed, 1);
  eq('新建被拒不得记为已上传', summary.created, 0);
  eq('新建被拒不写同步账本', Object.keys(f.journal.events).length, 0);
  eq('新建被拒仍保留日程', (await f.notes.loadAll()).events.length, 1);
  eq('提示区分不存在资源和版本冲突', f.messages[0].includes('可能已存在于其他未同步日历'), true);
}
{
  const f = await fixture(ev, true);
  let puts = 0;
  const summary = await f.run(async (o) => {
    if (o.method === 'REPORT') return ok(empty);
    if (o.method === 'GET') return ok(buildSingleIcs({ ...ev, title: '服务器版本' }), 200, { etag: 'new-etag' });
    puts++; return puts === 1 ? ok('', 412) : ok('', 204, { etag: 'accepted' });
  }, 'mine');
  const writes = f.requests.filter((r) => r.method === 'PUT');
  eq('增量未返回资源时使用账本 etag', writes[0].headers['If-Match'], 'old-etag');
  eq('保留本地重试必须带最新 etag', writes[1].headers['If-Match'], 'new-etag');
  eq('成功解决冲突不报失败', summary.failed, 0);
  eq('重试成功登记新版本', f.journal.events[ev.id].etag, 'accepted');
}
{
  const f = await fixture(ev, true);
  const summary = await f.run(async (o) => o.method === 'REPORT' ? ok(empty) : o.method === 'PUT' ? ok('', 412) : ok(buildSingleIcs({ ...ev, id: 'another-event' }), 200, { etag: 'x' }), 'mine');
  eq('服务器 UID 不同必须停止写入', f.requests.filter((r) => r.method === 'PUT').length, 1);
  eq('UID 不同明确计为失败', summary.failed, 1);
  eq('UID 不同保留旧账本身份', f.journal.events[ev.id].etag, 'old-etag');
}
{
  const f = await fixture({ ...ev, category: '不存在分类' }, false, [route, personal]);
  await f.run(async (o) => o.method === 'REPORT' ? ok(resource({ ...ev, title: '原来标题' }, personal.url + 'actual.ics', 'server')) : ok('', 204, { etag: 'new' }));
  const put = f.requests.find((r) => r.method === 'PUT');
  eq('收养现有 UID 使用真实资源地址', put.url, personal.url + 'actual.ics');
  eq('收养现有 UID 使用实际所属日历', f.journal.events[ev.id].calendarId, personal.id);
}
{
  const alarmEvent = { ...ev, title: '提醒,内容;测试', reminderMinutes: [30, 540] };
  const calendar = new ICAL.Component(ICAL.parse(buildSingleIcs(alarmEvent)));
  const alarms = calendar.getFirstSubcomponent('vevent')!.getAllSubcomponents('valarm');
  eq('保留每个提醒', alarms.length, 2);
  eq('显示提醒必须有描述且正确转义', alarms.every((a) => a.getFirstPropertyValue('description') === alarmEvent.title), true);
}
console.log(`上传条件与路由回归:${pass} 通过,0 失败`);
