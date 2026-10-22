import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { decorateInjectedPreview, observeInjectedPreview, injectionEditorExtension, type InjectionActions } from '../src/ui/inject-controls.ts';
import { applyInjection, listInjectedTasks, skipInjectedTask } from '../src/ui/inject.ts';
import { setLang } from '../src/l10n/strings.ts';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const name of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Window', 'Range']) (globalThis as any)[name] = dom.window[name];
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
(globalThis as any).cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
setLang('zh');
(dom.window.Range.prototype as any).getClientRects = () => [];
(dom.window.Range.prototype as any).getBoundingClientRect = () => ({ left:0,right:0,top:0,bottom:0,width:0,height:0 });
let pass = 0;
const eq = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); pass++; };
const marker = '> [!todo]+ todo';
const path = 'Daily/2026-10-20.md';
const items = [{ eventId: 'a', instanceKey: 'a-day', title: '日程甲', startTime: '09:00', allDay: false }, { eventId: 'b', instanceKey: 'b-day', title: '日程乙', startTime: '10:00', allDay: false }];
const initial = applyInjection(`${marker}\n\n正文\n`, { marker, items }).content;
const source = initial.replace('><!--ag2-injected-->', '><!--ag2-injected-->\n>>- [ ] 手写任务');
const tasks = listInjectedTasks(source, marker);
const calls: any[] = [];
const actions: InjectionActions = { marker: () => marker, eligible: p => p.startsWith('Daily/') && /\d{4}-\d{2}-\d{2}\.md$/.test(p),
  skip: async (p, key) => { calls.push(['skip', p, key]); }, restore: async (p, key) => { calls.push(['restore', p, key]); } };
const section = { lineStart: 0, lineEnd: source.split('\n').length - 1 };
const preview = () => {
  const el = document.createElement('div');
  el.innerHTML = '<div class="callout" data-callout="todo"><div class="callout-title">todo</div><div class="callout-content"><ul><li>手写任务</li><li><input type="checkbox">09:00 日程甲</li><li><input type="checkbox">10:00 日程乙</li></ul></div></div>';
  document.body.append(el); return el;
};
{
  const el = preview(); const before = source;
  const cleanup = decorateInjectedPreview(el, source, path, section, actions);
  eq('仅自动待办有跳过按钮', el.querySelectorAll('.ag2-inject-action').length, 2);
  eq('手写任务不加按钮', el.querySelector('li')!.querySelector('button'), null);
  eq('按钮渲染不修改日记文本', source, before);
  eq('按钮有触控及键盘语义', Array.from(el.querySelectorAll('button')).every(b => b.type === 'button' && !!b.getAttribute('aria-label')), true);
  let bubbling = 0; el.addEventListener('click', () => { bubbling++; });
  (el.querySelector('button') as HTMLButtonElement).click(); await Promise.resolve();
  eq('一键跳过调用确切文件和条目', calls.pop(), ['skip', path, tasks[0].key]);
  eq('点击不冒泡到任务勾选框', bubbling, 0);
  eq('点击不改变完成状态', Array.from(el.querySelectorAll('input')).every(input => !input.checked), true);
  decorateInjectedPreview(el, source, path, section, actions);
  eq('重复渲染不重复按钮', el.querySelectorAll('.ag2-inject-action').length, 2);
  cleanup(); eq('卸载清理按钮', el.querySelectorAll('.ag2-inject-action').length, 0);
  el.remove();
}
{
  const el = preview(); decorateInjectedPreview(el, source, 'Other/2026-10-20.md', section, actions);
  eq('范围外笔记没有按钮', el.querySelectorAll('button').length, 0); el.remove();
}
{
  const hidden = skipInjectedTask(source, marker, tasks[0].key, items);
  const el = preview(); el.querySelectorAll('li')[1].remove();
  decorateInjectedPreview(el, hidden, path, section, actions);
  eq('跳过后出现数量与恢复入口', el.querySelector('.ag2-inject-restore')!.textContent, '已跳过 1 项恢复');
  (el.querySelector('.ag2-inject-restore button') as HTMLButtonElement).click(); await Promise.resolve();
  eq('只有一项时点击立即恢复', calls.pop(), ['restore', path, tasks[0].key]); el.remove();
  const bothHidden = skipInjectedTask(hidden, marker, tasks[1].key, items);
  const all = document.createElement('div'); all.innerHTML = '<div class="callout" data-callout="todo"><div class="callout-title">todo</div></div>';
  decorateInjectedPreview(all, bothHidden, path, section, actions);
  eq('全部隐藏后仍可恢复', all.querySelectorAll('.ag2-inject-restore button').length, 1);
  (all.querySelector('button') as HTMLButtonElement).click(); await Promise.resolve();
  eq('多项恢复才打开选择列表', calls.pop(), ['restore', path, undefined]);
}
{
  const el = preview();
  // 同名手写任务不得按文本误认；源码和 DOM 的列表顺序能准确分辨。
  const sameName = source.replace('手写任务', '09:00 日程甲'); el.querySelector('li')!.textContent = '09:00 日程甲';
  decorateInjectedPreview(el, sameName, path, section, actions);
  eq('同名手写任务仍然不加按钮', el.querySelector('li')!.querySelector('button'), null);
  eq('同名同时间无法确认归属时不放按钮', el.querySelectorAll('li')[1].querySelectorAll('button').length, 0); el.remove();
}
{
  const li = document.createElement('li'); li.textContent = '09:00 日程甲';
  decorateInjectedPreview(li, source, path, { lineStart: 0, lineEnd: 0 }, actions);
  eq('单个列表项渲染也显示按钮', li.querySelectorAll('button').length, 1);
  const el = preview();
  decorateInjectedPreview(el, source, path, { lineStart: 0, lineEnd: 0 }, actions);
  eq('callout 标题范围不完整时仍识别唯一日程', el.querySelectorAll('button').length, 2); el.remove();
}
{
  const el = preview(); const cleanup = observeInjectedPreview(el, source, path, section, actions);
  el.querySelector('button')!.remove();
  await new Promise(resolve => setTimeout(resolve, 0));
  eq('其他任务插件重画后按钮仍保留', el.querySelectorAll('.ag2-inject-action').length, 2);
  cleanup(); await Promise.resolve();
  eq('卸载后观察器不会再加回按钮', el.querySelectorAll('.ag2-inject-action').length, 0); el.remove();
}
{
  const el = preview(); const ul = el.querySelector('ul')!;
  ul.insertBefore(ul.children[2], ul.children[1]);
  decorateInjectedPreview(el, source, path, section, actions);
  (el.querySelectorAll('li')[1].querySelector('button') as HTMLButtonElement).click(); await Promise.resolve();
  eq('任务插件排序后按钮仍对应可见的日程乙', calls.pop(), ['skip', path, tasks[1].key]); el.remove();
}
{
  const el = preview(); decorateInjectedPreview(el, source, path, section, actions);
  let completed = 0; el.querySelector('input')!.addEventListener('change', () => { completed++; });
  const before = calls.length; (el.querySelector('input') as HTMLInputElement).click();
  eq('正常勾选仍产生原生 change 事件', completed, 1);
  eq('正常勾选不会触发跳过', calls.length, before);
  eq('正常勾选状态正确', (el.querySelector('input') as HTMLInputElement).checked, true); el.remove();
}
{
  const el = preview(); let finish: () => void = () => {}; let runs = 0;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  decorateInjectedPreview(el, source, path, section, { ...actions, skip: async () => { runs++; await pending; } });
  const button = el.querySelector('button')!; button.click(); button.click();
  eq('连续点击只执行一次', runs, 1); eq('处理期间按钮暂时禁用', button.disabled, true);
  finish(); await pending; await Promise.resolve(); eq('完成后按钮恢复可用', button.disabled, false); el.remove();
}
{
  const el = preview(); const owned = new Set<HTMLElement>();
  decorateInjectedPreview(el, source, path, section, actions, owned);
  eq('只登记实际创建的节点', owned.size, 2);
  const cleanup = observeInjectedPreview(el, source, path, section, actions);
  // 多次重画后仍只有两个按钮，清理原有节点由其创建者负责。
  for (let i=0; i<20; i++) { el.querySelector('button')?.remove(); await Promise.resolve(); }
  await new Promise(resolve => setTimeout(resolve, 0));
  eq('重复重画后按钮数量不增长', el.querySelectorAll('button').length, 2);
  cleanup(); owned.forEach(n => n.remove()); el.remove();
}
{
  const el = preview(); decorateInjectedPreview(el, source, path, null, actions);
  eq('实时预览没有 section 时仍显示跳过按钮', el.querySelectorAll('button').length, 2); el.remove();
  const hidden = skipInjectedTask(source, marker, tasks[0].key, items);
  const target = preview(); target.querySelectorAll('li')[1].remove();
  decorateInjectedPreview(target, hidden, path, null, actions);
  eq('实时预览没有 section 时仍能恢复', target.querySelectorAll('.ag2-inject-restore').length, 1); target.remove();
  const unrelated = document.createElement('div'); unrelated.innerHTML='<div class="callout" data-callout="warning">其他区块</div>';
  decorateInjectedPreview(unrelated, hidden, path, null, actions);
  eq('恢复入口不会跑到无关的 callout', unrelated.querySelectorAll('.ag2-inject-restore').length, 0);
}
{
  const parent = document.createElement('div'); document.body.append(parent);
  const extension = injectionEditorExtension(actions, () => path);
  const view = new EditorView({ parent, state: EditorState.create({ doc: source, extensions: [extension] }) });
  eq('真实编辑器显示两个跳过按钮', view.dom.querySelectorAll('.ag2-inject-action').length, 2);
  (view.dom.querySelector('.ag2-inject-action') as HTMLButtonElement).click(); await Promise.resolve();
  eq('编辑器按钮定位正确条目', calls.pop(), ['skip', path, tasks[0].key]);
  const hidden = skipInjectedTask(source, marker, tasks[0].key, items);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: hidden } });
  eq('文档更新后编辑器移除已跳过按钮', view.dom.querySelectorAll('button.ag2-inject-action').length, 2);
  eq('编辑器更新后出现恢复按钮', view.dom.querySelector('.ag2-inject-restore')!.textContent, '已跳过 1 项恢复');
  eq('显示按钮不会写入文档', view.state.doc.toString(), hidden);
  view.destroy(); parent.remove();
}
{
  const parent = document.createElement('div'); document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: source, extensions: [injectionEditorExtension(actions, () => path)] }) });
  const callout = preview(); view.scrollDOM.append(callout);
  await new Promise(resolve => setTimeout(resolve, 60));
  eq('编辑器内渲染出的 callout 也有按钮', callout.querySelectorAll('button.ag2-inject-action').length, 2);
  view.dispatch({ changes: { from: view.state.doc.length, insert: '\n继续编辑正文' } });
  await new Promise(resolve => setTimeout(resolve, 60));
  eq('正文继续编辑后 callout 按钮不消失', callout.querySelectorAll('button.ag2-inject-action').length, 2);
  eq('编辑器观察器不改写正文', view.state.doc.toString().endsWith('继续编辑正文'), true);
  view.destroy(); eq('关闭编辑器会清理 callout 按钮', callout.querySelectorAll('button.ag2-inject-action').length, 0); parent.remove();
}
console.log(`日记快捷按钮回归:${pass} 通过,0 失败`);
dom.window.close();
