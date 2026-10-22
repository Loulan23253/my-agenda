/**
 * Apple 日历风格的时间网格(独立模块,日/周视图共用):
 * - 全天区:与列对齐的独立行,事件以彩色药丸呈现
 * - 小时线 + 半小时浅线,时段背景带退为底层
 * - 重叠事件并排分道(lane),块内标题/时刻分层
 * - 当前时刻:红色横线 + 左缘红点(仅当视图包含今天)
 * - 点击空白:按 30 分钟对齐新建
 * - 拖拽:块可纵向移动/底缘调长;周视图移动可跨列换天(幽灵跟随指针,30 分钟对齐提交)
 */
import { t, getLang } from "../l10n/strings";
import { dateKey, startOfDay, type WeekStartDay } from "../kernel/dates";
import { parseLocal, type Occurrence } from "../core/occurrences";
import { categoryColor } from "./palette";

const HOUR_ROW_EM = 2.4;
const pad = (n: number) => String(n).padStart(2, "0");

// —— 块拖拽参数:触发阈值 / 提交对齐 / 跨列幽灵纵向预对齐 / 最小时长 / 底缘调长热区 ——
const DRAG_THRESHOLD_PX = 4;
const SNAP_MIN = 15;
const GHOST_SNAP_MIN = 30;
const MIN_DUR_MIN = 20;
const RESIZE_HOTZONE_PX = 8;

/** 拖拽结束后的 click 抑制标志:块 click 处理开头检测到则清零并忽略,防止拖拽误触发打开编辑。 */
let suppressClick = false;

/** 记住每个网格(按天数+起始日)的滚动位置:重渲染(拖拽提交/同步)不跳位。 */
let savedGridScroll: { key: string; top: number } | null = null;

/** 分钟数(可含小数)→ "HH:MM"(仅用于拖拽预览显示)。 */
function minToHHMM(min: number): string {
  const m = Math.max(0, Math.floor(min));
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
}

/** 把分钟数四舍五入对齐到 step。 */
function snapTo(min: number, step: number): number {
  return Math.round(min / step) * step;
}

/** 指针 x → 目标列序号(列等宽:wrapper 宽度 ÷ 列数),钳制到 0..列数-1。 */
function colIndexAt(wrapRect: DOMRect, clientX: number, colCount: number): number {
  const colW = wrapRect.width / colCount;
  if (colW <= 0) return 0;
  const idx = Math.floor((clientX - wrapRect.left) / colW);
  return Math.min(Math.max(idx, 0), colCount - 1);
}

export interface TimeGridDeps {
  today: Date;
  weekStartDay: WeekStartDay;
  onOpen(occ: Occurrence): void;
  onCreateAt(dateKeyStr: string, startHHMM?: string, endHHMM?: string): void;
  /** 拖拽/调整后提交新的起止时刻(仅定时事件)。 */
  onMove(occ: Occurrence, startsAt: string, endsAt: string): void;
}

/** 固定可视窗口:00:00–24:00 全天覆盖。 */
const WIN = { from: 0, to: 24 };

interface LanePlacement {
  occ: Occurrence;
  lane: number;
  lanes: number;
}

/** 重叠事件并排分道:同一簇内等宽,簇间互不影响(Apple 的布局方式)。 */
function layoutLanes(items: Occurrence[]): LanePlacement[] {
  const sorted = [...items].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const endMs = (o: Occurrence) => parseLocal(o.end ?? o.start).getTime();
  const result: LanePlacement[] = [];
  let cluster: { occ: Occurrence; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const closeCluster = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const c of cluster) result.push({ occ: c.occ, lane: c.lane, lanes });
    cluster = [];
    laneEnds = [];
  };

  for (const occ of sorted) {
    const startMs = parseLocal(occ.start).getTime();
    if (startMs >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((e) => e <= startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = endMs(occ);
    cluster.push({ occ, lane });
    clusterEnd = Math.max(clusterEnd, endMs(occ));
  }
  closeCluster();
  return result;
}

export function renderAllDaySection(
  container: HTMLElement,
  allday: Occurrence[],
  days: Date[],
  deps: TimeGridDeps,
): void {
  // 列索引:0..N-1(与时间网格的日列一一对应)
  const colIndex = new Map<string, number>();
  days.forEach((d, i) => colIndex.set(dateKey(d), i));
  const lastKey = dateKey(days[days.length - 1]);

  // 同一事件的多日实例合并为一条跨列色条(colStart 含 / colEndExcl 不含)
  interface SpanBar {
    occ: Occurrence;
    colStart: number;
    colEndExcl: number;
    row: number;
  }
  const spanMap = new Map<string, SpanBar>();
  for (const o of allday) {
    const startCol = colIndex.get(dateKey(parseLocal(o.start)));
    if (startCol === undefined) continue;
    let endExcl = colIndex.get(dateKey(parseLocal(o.end ?? o.start)));
    if (endExcl === undefined) endExcl = o.start >= lastKey ? days.length : startCol + 1;
    const prev = spanMap.get(o.event.id);
    if (prev && startCol <= prev.colEndExcl) {
      // 仅首尾相接的片段并入同一色条(多日全天事件的逐日片段);
      // 不连续的重复实例(如一三五)各自成条,避免被画成贯通全周
      prev.colStart = Math.min(prev.colStart, startCol);
      prev.colEndExcl = Math.max(prev.colEndExcl, endExcl);
    } else {
      spanMap.set(o.event.id, { occ: o, colStart: startCol, colEndExcl: Math.max(endExcl, startCol + 1), row: 0 });
    }
  }

  // 分行:同一行的色条不重叠(先按起点排序,逐行放置)
  const bars = [...spanMap.values()].sort(
    (a, b) => a.colStart - b.colStart || a.colEndExcl - b.colEndExcl,
  );
  const rowCols: Map<number, string>[] = [];
  for (const bar of bars) {
    let row = 0;
    for (;;) {
      let free = true;
      for (let c = bar.colStart; c < bar.colEndExcl; c++) {
        if (rowCols[row]?.get(c)) {
          free = false;
          break;
        }
      }
      if (free) break;
      row++;
      if (row > 30) break;
    }
    rowCols[row] ??= new Map();
    for (let c = bar.colStart; c < bar.colEndExcl; c++) rowCols[row].set(c, bar.occ.event.id);
    bar.row = row;
  }
  const rowCount = Math.max(1, rowCols.length);

  // CSS Grid:第 1 列是"全天"标签槽(纵跨所有行),其后与日列对齐
  const grid = container.createDiv({ cls: "ag2-alldaygrid" });
  grid.style.gridTemplateColumns = `3em repeat(${days.length}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rowCount}, 1.7em)`;

  const gutter = grid.createDiv({ cls: "ag2-allday-gutter" });
  gutter.style.gridRow = `1 / ${rowCount + 1}`;
  gutter.createDiv({ cls: "ag2-allday-gutterlabel", text: t("panel.allDay") });

  for (const bar of bars) {
    const color = bar.occ.event.category ? categoryColor(bar.occ.event.category) : "";
    const pill = grid.createDiv({ cls: "ag2-allday-pill" });
    pill.style.gridColumn = `${bar.colStart + 2} / ${bar.colEndExcl + 2}`;
    pill.style.gridRow = `${bar.row + 1}`;
    if (bar.occ.event.category) pill.style.setProperty("--pill-c", color);
    pill.textContent = bar.occ.event.title;
    pill.title = bar.occ.event.title;
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      deps.onOpen(bar.occ);
    });
  }
}

export function renderTimeGrid(
  container: HTMLElement,
  occs: Occurrence[],
  days: Date[],
  deps: TimeGridDeps,
  between?: (grid: HTMLElement) => void,
): void {
  // 类标记替代 :has 选择器(审核性能建议):上层 .ag2-body 据此切换网格布局
  container.closest(".ag2-body")?.addClass("ag2-has-timegrid");
  const win = WIN;
  const hours = win.to - win.from;
  const span = hours * 60;
  const colH = `${hours * HOUR_ROW_EM}em`;
  const todayK = dateKey(startOfDay(deps.today));
  const includesToday = days.some((d) => dateKey(d) === todayK);
  const nowMin = deps.today.getHours() * 60 + deps.today.getMinutes();
  const nowTop = ((Math.max(Math.min(nowMin, win.to * 60), win.from * 60) - win.from * 60) / span) * 100;

  // 列头(带与列体对齐的标签槽)
  const colHeader = container.createDiv({ cls: "ag2-grid-cols" });
  colHeader.createDiv({ cls: "ag2-grid-gutter" });
  for (const d of days) {
    const c = colHeader.createDiv({ cls: "ag2-grid-colhead" });
    c.addClass(`is-wd-${d.getDay()}`);
    if (dateKey(d) === todayK) c.addClass("is-today");
    c.textContent = getColhead(d);
  }

  // Apple/ogenda 顺序:列头在最上,全天区/贯通条次之,时间网格最后
  if (between) between(container);

  const body = container.createDiv({ cls: "ag2-grid-body" });
  container.style.setProperty("--ag-col-h", colH);

  // 刻度列:小时标签 + 当前时刻红点(固定行高,内部滚动)
  const gutter = body.createDiv({ cls: "ag2-grid-gutter" });
  gutter.style.height = colH;
  for (let h = win.from; h < win.to; h++) {
    const hourBox = gutter.createDiv({ cls: "ag2-grid-hour" });
    hourBox.createDiv({ cls: "ag2-grid-hour-label", text: `${pad(h)}:00` });
  }
  // 日程列:时段背景带 + 小时/半小时线 + 事件块 + 当前时刻线
  const colsWrap = body.createDiv({ cls: "ag2-grid-cols" });
  const dayCols: HTMLElement[] = [];
  for (const d of days) {
    const col = colsWrap.createDiv({ cls: "ag2-grid-col" });
    col.style.height = colH;
    // 小时线由 .ag2-grid-col 的 repeating-linear-gradient 绘制(不再逐槽建 div)
    col.addEventListener("click", (e) => {
      // 拖拽划时长结束后的原生 click 不再触发点按新建
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const rect = col.getBoundingClientRect();
      const mins = win.from * 60 + ((e.clientY - rect.top) / rect.height) * span;
      const snapped = Math.floor(mins / 30) * 30;
      deps.onCreateAt(dateKey(d), `${pad(Math.floor(snapped / 60) % 24)}:${pad(snapped % 60)}`);
    });
    // 拖拽划时长:空白处按住下拉 → 预览高亮 → 松手带起止时刻打开编辑(Apple 式)
    col.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      if ((e.target as HTMLElement).closest(".ag2-grid-block")) return;
      const rect = col.getBoundingClientRect();
      const snapMin = (clientY: number): number => {
        const raw = win.from * 60 + ((clientY - rect.top) / (rect.height || 1)) * span;
        return Math.min(Math.max(Math.round(raw / 15) * 15, win.from * 60), win.to * 60);
      };
      const y0 = e.clientY;
      const startMin0 = snapMin(y0);
      let preview: HTMLElement | null = null;
      let draggingCreate = false;
      try { col.setPointerCapture(e.pointerId); } catch { /* 降级 */ }
      const onMove = (ev2: PointerEvent) => {
        if (Math.abs(ev2.clientY - y0) < 12 && !preview) return;
        if (!preview) {
          draggingCreate = true;
          preview = col.createDiv({ cls: "ag2-create-drag" });
          }
        const a = Math.min(startMin0, snapMin(ev2.clientY));
        const b = Math.max(startMin0, snapMin(ev2.clientY));
        preview.style.top = `${((a - win.from * 60) / span) * 100}%`;
        preview.style.height = `${((b - a) / span) * 100}%`;
        preview.textContent = `${minToHHMM(a)}–${minToHHMM(b)}`;
      };
      const onUp = (ev2: PointerEvent) => {
        col.removeEventListener("pointermove", onMove);
        col.removeEventListener("pointerup", onUp);
        col.removeEventListener("pointercancel", onUp);
        if (!preview) return;
        const text = preview.textContent ?? "";
        preview.remove();
        preview = null;
        if (!draggingCreate) return;
        suppressClick = true;
        const a = Math.min(startMin0, snapMin(ev2.clientY));
        const b = Math.max(startMin0, snapMin(ev2.clientY));
        if (b - a >= 15) {
          deps.onCreateAt(dateKey(d), minToHHMM(a), minToHHMM(b));
        } else {
          // 划动距离不足一个对齐步长:退化为普通点击新建
          deps.onCreateAt(dateKey(d), minToHHMM(a));
        }
        void text;
      };
      col.addEventListener("pointermove", onMove);
      col.addEventListener("pointerup", onUp);
      col.addEventListener("pointercancel", onUp);
    });
    dayCols.push(col);
  }

  // 当前时刻:一条贯穿整周/整日的红线(而非每列一段)
  if (includesToday && nowMin >= win.from * 60 && nowMin <= win.to * 60) {
    const line = colsWrap.createDiv({ cls: "ag2-nowline" });
    line.style.top = `${nowTop}%`;
  }

  // 事件块:并排分道 + 分类色柔底
  const byDay = new Map<string, Occurrence[]>();
  for (const o of occs) {
    if (o.event.isAllDay) continue;
    const k = dateKey(parseLocal(o.start));
    const list = byDay.get(k) ?? [];
    list.push(o);
    byDay.set(k, list);
  }
  for (const d of days) {
    const idx = days.indexOf(d);
    const col = dayCols[idx];
    if (!col) continue;
    for (const { occ, lane, lanes } of layoutLanes(byDay.get(dateKey(d)) ?? [])) {
      const start = parseLocal(occ.start);
      const end = occ.end ? parseLocal(occ.end) : new Date(start.getTime() + 3600_000);
      const startMin = Math.max(win.from * 60, start.getHours() * 60 + start.getMinutes());
      // 结束在次日(跨零点片段)→ 画到当天底,否则"时:分"折算成 0 点只剩小块
      let endOfDayMin = end.getHours() * 60 + end.getMinutes();
      if (dateKey(end) > dateKey(start)) endOfDayMin = win.to * 60;
      const endMin = Math.min(win.to * 60, Math.max(endOfDayMin, startMin + 20));
      if (endMin <= startMin) continue;
      // 无分类的日程用强调色(而不是灰色):iCloud 同步来的日程大多没有分类字段
      const color = occ.event.category ? categoryColor(occ.event.category) : "";
      const block = col.createDiv({ cls: "ag2-grid-block" });
      const width = 100 / lanes;
      block.style.top = `${((startMin - win.from * 60) / span) * 100}%`;
      block.style.height = `${((endMin - startMin) / span) * 100}%`;
      block.style.left = `calc(${(lane * width).toFixed(3)}% + 2px)`;
      block.style.width = `calc(${width.toFixed(3)}% - 4px)`;
      block.style.setProperty("--block-color", color || "var(--ag-tint)");
      const durMin = endMin - startMin;
      block.createDiv({ cls: "ag2-block-title", text: occ.event.title });
      if (durMin >= 100) {
        const endT = occ.end ? occ.end.slice(11, 16) : "";
        block.createDiv({ cls: "ag2-block-time", text: endT ? `${occ.start.slice(11, 16)}–${endT}` : occ.start.slice(11, 16) });
      }
      block.title = `${occ.event.title} · ${occ.start.slice(11, 16)}${endT2(occ)}`;
      block.addEventListener("click", (e) => {
        e.stopPropagation();
        // 拖拽刚结束:吞掉这次 click,避免误触发打开编辑
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        deps.onOpen(occ);
      });

      // —— 指针拖拽:移动 / 调长事件块(pointer 事件,与列级 click 创建互不干扰)——
      let gestureActive = false; // 指针仍按在该块上
      let dragging = false; // 已越过阈值,进入拖拽
      let mode: "move" | "resize" = "move";
      let startY = 0;
      const baseStart = startMin;
      const baseEnd = endMin;
      let prevStart = startMin; // 最近一次预览分钟
      let prevEnd = endMin;
      let colHeight = 1;
      const scroller = colsWrap.parentElement; // .ag2-grid-body(唯一滚动区)
      const scrollTop0 = scroller ? scroller.scrollTop : 0;
      const savedChildren = Array.from(block.childNodes); // 拖拽结束后还原标题/时刻子节点
      let ghost: HTMLElement | null = null; // 跨列拖拽幽灵(挂列容器 wrapper)
      let ghostW = 0; // 幽灵宽度 = 单列宽度(px)

      // 进入移动拖拽:隐藏原块,在 wrapper(position:relative)上创建幽灵
      const startGhost = () => {
        ghostW = col.offsetWidth || 1;
        ghost = colsWrap.createDiv({ cls: "ag2-drag-ghost" });
        ghost.style.width = `${ghostW}px`;
        ghost.style.setProperty("--block-color", color || "var(--ag-tint)");
        ghost.textContent = occ.event.title;
        block.addClass("is-drag-source"); // 原块隐藏,由幽灵接管视觉
      };

      // 幽灵跟随指针:纵向按 30 分钟预对齐换算 top,横向按指针居中,均钳制在 wrapper 内
      const moveGhost = (e: PointerEvent) => {
        if (!ghost) return;
        const wrapRect = colsWrap.getBoundingClientRect();
        const wrapH = wrapRect.height || 1;
        const dur = baseEnd - baseStart;
        const rawMin = win.from * 60 + ((e.clientY - wrapRect.top) / wrapH) * span;
        const ghostMin = Math.min(Math.max(snapTo(rawMin, GHOST_SNAP_MIN), win.from * 60), win.to * 60 - dur);
        const topPx = ((ghostMin - win.from * 60) / span) * wrapH;
        const leftPx = Math.min(Math.max(e.clientX - wrapRect.left - ghostW / 2, 0), Math.max(wrapRect.width - ghostW, 0));
        ghost.style.top = `${topPx}px`;
        ghost.style.left = `${leftPx}px`;
      };

      block.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !e.isPrimary) return;
        suppressClick = false; // 新手势开始,清掉可能残留的抑制标志
        gestureActive = true;
        dragging = false;
        startY = e.clientY;
        // 光标落在底缘热区 → 调长模式,否则整体移动;先不 stopPropagation
        const rect = block.getBoundingClientRect();
        mode = e.clientY - rect.top > rect.height - RESIZE_HOTZONE_PX ? "resize" : "move";
        try {
          block.setPointerCapture(e.pointerId);
        } catch {
          /* 个别环境不支持指针捕获,降级为普通事件流 */
        }
      });

      block.addEventListener("pointermove", (e) => {
        if (!gestureActive) {
          // 悬停:靠近底缘时给出“可调长”光标
          const rect = block.getBoundingClientRect();
          block.classList.toggle("is-resize-mode", e.clientY - rect.top > rect.height - RESIZE_HOTZONE_PX);
          return;
        }
        const dy = e.clientY - startY;
        if (!dragging) {
          if (Math.abs(dy) <= DRAG_THRESHOLD_PX) return; // 位移太小,仍视为点击
          dragging = true;
          block.classList.add("is-dragging");
          colHeight = col.getBoundingClientRect().height || 1;
          if (mode === "move") startGhost(); // 移动模式:创建跨列幽灵(调长仍限本列,不建幽灵)
        }
        e.preventDefault(); // 拖拽期间阻止文本选中
        // 近网格体上下边缘 → 自动滚动(否则够不到可视区外的小时)
        if (scroller) {
          const sr = scroller.getBoundingClientRect();
          const EDGE = 30;
          if (e.clientY < sr.top + EDGE) scroller.scrollTop -= Math.min(sr.top + EDGE - e.clientY, 40) * 0.35;
          else if (e.clientY > sr.bottom - EDGE) scroller.scrollTop += Math.min(e.clientY - (sr.bottom - EDGE), 40) * 0.35;
        }
        // 像素位移(含手势期间的滚动量)→ 分钟位移,实时更新预览(move 整体平移 / resize 只改底部)
        const dScroll = scroller ? scroller.scrollTop - scrollTop0 : 0;
        const deltaMin = (dy + dScroll) * (span / colHeight);
        const dur = baseEnd - baseStart;
        if (mode === "move") {
          prevStart = Math.min(Math.max(baseStart + deltaMin, win.from * 60), win.to * 60 - dur);
          prevEnd = prevStart + dur;
        } else {
          prevStart = baseStart;
          prevEnd = Math.min(Math.max(baseEnd + deltaMin, baseStart + MIN_DUR_MIN), win.to * 60);
        }
        block.style.top = `${((prevStart - win.from * 60) / span) * 100}%`;
        block.style.height = `${((prevEnd - prevStart) / span) * 100}%`;
        block.textContent = `${minToHHMM(prevStart)}–${minToHHMM(prevEnd)} ${occ.event.title}`;
        if (ghost) moveGhost(e); // 幽灵跟随指针(跨列预览)
      });

      const endGesture = (commit: boolean, up?: PointerEvent) => {
        if (!gestureActive) return;
        gestureActive = false;
        block.classList.remove("is-resize-mode");
        if (!dragging) return; // 未进入拖拽:原生 click 照常触发 onOpen
        dragging = false;
        block.classList.remove("is-dragging");
        block.replaceChildren(...savedChildren); // 还原标题/时刻子节点
        const crossCol = ghost !== null; // 本次移动拖拽启用了跨列幽灵
        if (ghost) {
          ghost.remove(); // 幽灵用完即撤(提交后的块重建由 onMove 触发重渲染接管)
          ghost = null;
        }
        if (!commit) {
          // 取消(如 pointercancel):还原到原位并恢复可见
          block.removeClass("is-drag-source");
          block.style.top = `${((baseStart - win.from * 60) / span) * 100}%`;
          block.style.height = `${((baseEnd - baseStart) / span) * 100}%`;
          return;
        }
        // 对齐 + 窗口约束(20 分钟下限),按目标列日期构造本地墙钟 ISO
        const dur = baseEnd - baseStart;
        let newStart: number;
        let newEnd: number;
        let isoDay = dateKey(d); // 缺省:原列日期
        if (mode === "resize") {
          newStart = baseStart;
          newEnd = Math.min(Math.max(snapTo(prevEnd, SNAP_MIN), baseStart + MIN_DUR_MIN), win.to * 60);
        } else if (crossCol && up) {
          // 跨列移动:目标列取指针 x(等分宽度),开始分钟取 30 分钟对齐后的指针纵向分钟(与幽灵预览同一换算)
          const wrapRect = colsWrap.getBoundingClientRect();
          const tCol = colIndexAt(wrapRect, up.clientX, days.length);
          const rawMin = win.from * 60 + ((up.clientY - wrapRect.top) / (wrapRect.height || 1)) * span;
          newStart = Math.min(Math.max(snapTo(rawMin, GHOST_SNAP_MIN), win.from * 60), win.to * 60 - dur);
          newEnd = newStart + dur;
          isoDay = dateKey(days[tCol]);
        } else {
          newStart = Math.min(Math.max(snapTo(prevStart, SNAP_MIN), win.from * 60), win.to * 60 - dur);
          newEnd = newStart + dur;
        }
        // 分钟可超过 1440(拖到窗口底缘):用真实日期进位,避免 24:00 回绕成 00:00
        const toIso = (min: number) => {
          const dayStart = parseLocal(`${isoDay}T00:00:00`);
          const d = new Date(dayStart.getTime() + min * 60_000);
          return `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
        };
        suppressClick = true; // 抑制随后的原生 click
        window.setTimeout(() => {
          suppressClick = false; // 兜底:click 未派发(如被弹窗拦截)时防残留吞掉后续点击
        }, 0);
        deps.onMove(occ, toIso(newStart), toIso(newEnd));
        // 保险:onMove 的实现若未触发重渲染,原块不能停留在隐藏态
        block.removeClass("is-drag-source");
      };
      block.addEventListener("pointerup", (e) => endGesture(true, e));
      block.addEventListener("pointercancel", () => endGesture(false));
    }
  }

  // 打开即看到有用时段:首次锚到当前时刻前 1.5h(无今日则 07:00);同周重渲染恢复原滚动位
  const posKey = `${days.length}@${dateKey(days[0])}`;
  body.addEventListener("scroll", () => {
    savedGridScroll = { key: posKey, top: body.scrollTop };
  }, { passive: true });
  window.requestAnimationFrame(() => {
    const maxTop = Math.max(0, body.scrollHeight - body.clientHeight);
    const restored = savedGridScroll && savedGridScroll.key === posKey ? savedGridScroll.top : null;
    const anchorMin = includesToday ? Math.max(0, Math.min(nowMin - 90, 22 * 60)) : 7 * 60;
    const want = restored ?? Math.min((anchorMin / span) * body.scrollHeight, maxTop);
    body.scrollTop = Math.min(want, maxTop);
  });
}

function endT2(occ: Occurrence): string {
  return occ.end ? `–${occ.end.slice(11, 16)}` : "";
}

function getColhead(d: Date): string {
  const zh = getLang() === "zh";
  const wd = zh ? ["日", "一", "二", "三", "四", "五", "六"][d.getDay()] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return zh ? `周${wd} ${d.getDate()}` : `${wd} ${d.getDate()}`;
}
