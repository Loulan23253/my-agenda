import type { Editor } from 'obsidian';

/** 在当前编辑缓冲区中做最小替换：保留未保存的输入，并使用编辑器原生撤销。 */
export function updateEditorText(editor: Pick<Editor, 'getValue' | 'offsetToPos' | 'replaceRange'>, transform: (current: string) => string): boolean {
  const current = editor.getValue();
  const next = transform(current);
  if (next === current) return false;
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from++;
  let oldEnd = current.length, newEnd = next.length;
  while (oldEnd > from && newEnd > from && current[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
  editor.replaceRange(next.slice(from, newEnd), editor.offsetToPos(from), editor.offsetToPos(oldEnd));
  return true;
}
