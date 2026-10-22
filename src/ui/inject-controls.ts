import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { listInjectedTasks, listSkippedTasks } from './inject';
import { t } from '../l10n/strings';

export interface InjectionActions {
  marker(): string;
  eligible(path: string): boolean;
  skip(path: string, key: string): Promise<void>;
  restore(path: string, key?: string): Promise<void>;
}

function actionButton(doc: Document, label: string, title: string, action: () => Promise<void>): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'ag2-inject-action';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  // 点击按钮不能顺便切换完成状态或把光标移进注释。
  button.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
  button.addEventListener('click', async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    try { await action(); }
    catch (error) { console.error('[myagenda-v2] injection action failed', error); }
    finally { button.disabled = false; }
  });
  return button;
}

function restoreControl(doc: Document, source: string, path: string, actions: InjectionActions): HTMLElement | undefined {
  const skipped = listSkippedTasks(source, actions.marker());
  if (!skipped.length) return undefined;
  const span = doc.createElement('span');
  span.className = 'ag2-inject-restore';
  const count = doc.createElement('span');
  count.textContent = t('inject.skippedCount', { n: skipped.length });
  span.append(count, actionButton(doc, t('inject.restoreButton'), t('cmd.restoreInjected'),
    () => actions.restore(path, skipped.length === 1 ? skipped[0].key : undefined)));
  return span;
}

/** 阅读模式及实时预览渲染出的 callout：只给有明确来源标记的自动行加按钮。 */
export function decorateInjectedPreview(
  el: HTMLElement, source: string, path: string, section: { lineStart: number; lineEnd: number } | null, actions: InjectionActions,
  ownedNodes?: Set<HTMLElement>,
): () => void {
  const added: HTMLElement[] = [];
  if (!actions.eligible(path)) return () => {};
  const marker = actions.marker();
  const calloutType = /\[!([^\]]+)\]/.exec(marker)?.[1].toLowerCase();
  const callouts = [...(el.matches('.callout') ? [el] : []), ...Array.from(el.querySelectorAll<HTMLElement>('.callout'))];
  const injectionCallout = callouts.find((node) => node.dataset.callout?.toLowerCase() === calloutType);
  const tasks = listInjectedTasks(source, marker);
  const sourceLines = source.split('\n');
  // Obsidian 的实时预览经常不提供 section；只在确定是目标 callout 时补恢复入口。
  const bounds = section ?? (injectionCallout ? { lineStart: 0, lineEnd: sourceLines.length - 1 } : { lineStart: -1, lineEnd: -1 });
  const allListLines = sourceLines.map((row, line) => ({ row, line })).filter(({ row }) => /^(?:\s*>\s*)*\s*(?:[-*+] |\d+[.)] )/.test(row));
  const lis = [...(el.matches('li, .task-list-item') ? [el] : []), ...Array.from(el.querySelectorAll<HTMLElement>('li, .task-list-item'))];
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const visibleLabel = (s: string) => normalize(s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|__|~~|`/g, ''));
  const ownText = (li: HTMLElement) => {
    const copy = li.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('ul, ol, button, input, .ag2-inject-restore').forEach((node) => node.remove());
    return normalize(copy.textContent ?? '');
  };
  const labels = lis.map(ownText);
  for (const task of tasks) {
    const label = visibleLabel(task.label);
    const candidates = lis.filter((_li, i) => labels[i] === label);
    const sourceMatches = allListLines.filter(({ row }) => visibleLabel(row.replace(/^(?:\s*>\s*)*\s*[-*+]\s+(?:\[[^\]]*\]\s*)?/, '').replace(/\s*<!--.*?-->/g, '')) === label);
    // Tasks 会排序，不能依赖 DOM 顺序。同名手写项等情况无法确认归属时不放按钮。
    const li = candidates.length === 1 && sourceMatches.length === 1 ? candidates[0] : undefined;
    if (!li) continue;
    const existing = li.querySelector<HTMLButtonElement>(':scope > .ag2-inject-action');
    if (existing?.dataset.ag2Key === task.key) continue;
    existing?.remove();
    const button = actionButton(el.ownerDocument, t('inject.skipButton'), t('inject.skipThis'), () => actions.skip(path, task.key));
    button.dataset.ag2Key = task.key;
    li.append(button); added.push(button); ownedNodes?.add(button);
  }
  const skipped = listSkippedTasks(source, marker);
  if (skipped.some((task) => task.line! >= bounds.lineStart && task.line! <= bounds.lineEnd)) {
    const footer = restoreControl(el.ownerDocument, source, path, actions);
    const host = injectionCallout ?? (el.matches('.callout') ? el : el.querySelector<HTMLElement>('.callout') ?? el);
    if (footer && !host.querySelector('.ag2-inject-restore')) { host.append(footer); added.push(footer); ownedNodes?.add(footer); }
  }
  return () => added.forEach((node) => node.remove());
}

/** Tasks 等插件可能在后续重画列表项，重挂按钮，但不改它们的任务 DOM 或源文件。 */
export function observeInjectedPreview(
  el: HTMLElement, source: string, path: string, section: { lineStart: number; lineEnd: number } | null, actions: InjectionActions,
): () => void {
  if (!actions.eligible(path) || (!listInjectedTasks(source, actions.marker()).length && !listSkippedTasks(source, actions.marker()).length)) return () => {};
  const nodes = new Set<HTMLElement>();
  const refresh = () => {
    // 长时间打开并反复刷新任务时，不保留已经移走的按钮节点。
    nodes.forEach((node) => { if (!el.contains(node)) nodes.delete(node); });
    decorateInjectedPreview(el, source, path, section, actions, nodes);
  };
  refresh();
  const Observer = el.ownerDocument.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(refresh) : undefined;
  observer?.observe(el, { childList: true, subtree: true });
  return () => { observer?.disconnect(); nodes.forEach((node) => node.remove()); nodes.clear(); };
}

class InjectionWidget extends WidgetType {
  constructor(private path: string, private key: string, private restore: boolean, private source: string, private actions: InjectionActions) { super(); }
  eq(other: InjectionWidget): boolean {
    return this.path === other.path && this.key === other.key && this.restore === other.restore && (!this.restore || this.source === other.source);
  }
  toDOM(view: EditorView): HTMLElement {
    return this.restore ? restoreControl(view.dom.ownerDocument, this.source, this.path, this.actions)! :
      actionButton(view.dom.ownerDocument, t('inject.skipButton'), t('inject.skipThis'), () => this.actions.skip(this.path, this.key));
  }
  ignoreEvent(): boolean { return true; }
}

/** 源码/实时编辑行也提供相同按钮；不往 Markdown 里写按钮或链接。 */
export function injectionEditorExtension(actions: InjectionActions, getPath: (view: EditorView) => string | undefined): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    path?: string;
    private previewCleanup?: () => void;
    private previewSource?: string;
    private previewPath?: string;
    private destroyed = false;
    constructor(view: EditorView) { this.decorations = this.build(view); this.schedulePreview(view); }
    update(update: ViewUpdate) {
      if (update.docChanged || getPath(update.view) !== this.path) {
        this.previewCleanup?.(); this.previewCleanup = undefined;
      }
      if (update.docChanged || update.viewportChanged || getPath(update.view) !== this.path) {
        this.decorations = this.build(update.view); this.schedulePreview(update.view);
      }
    }
    private schedulePreview(view: EditorView) {
      // 实时预览的 callout 不一定经过 Markdown 后处理；在编辑器完成 DOM 更新后单独接管按钮。
      view.requestMeasure({ key: this, read: () => null, write: () => {
        if (this.destroyed) return;
        const path = getPath(view), source = view.state.doc.toString();
        if (!path || !actions.eligible(path)) return;
        if (this.previewCleanup && this.previewPath === path && this.previewSource === source) return;
        this.previewCleanup?.(); this.previewPath = path; this.previewSource = source;
        this.previewCleanup = observeInjectedPreview(view.dom, source, path, null, actions);
      } });
    }
    destroy() { this.destroyed = true; this.previewCleanup?.(); }
    build(view: EditorView): DecorationSet {
      this.path = getPath(view);
      if (!this.path || !actions.eligible(this.path)) return Decoration.none;
      const source = view.state.doc.toString();
      const tasks = listInjectedTasks(source, actions.marker());
      const skipped = listSkippedTasks(source, actions.marker());
      const ranges = tasks.map((task) => ({ line: task.line!, key: task.key, restore: false }));
      if (skipped.length) ranges.push({ line: skipped[0].line!, key: '', restore: true });
      ranges.sort((a, b) => a.line - b.line);
      const builder = new RangeSetBuilder<Decoration>();
      for (const item of ranges) {
        const pos = view.state.doc.line(item.line + 1).to;
        builder.add(pos, pos, Decoration.widget({ widget: new InjectionWidget(this.path, item.key, item.restore, source, actions), side: 1 }));
      }
      return builder.finish();
    }
  }, { decorations: (plugin) => plugin.decorations });
}
