/** 五个视图:日程流(按天)/ 日时间网格 / 周网格 / 月网格 / 统计。 */
import { t, getLang } from "../l10n/strings";
import type { CalendarEvent } from "../model/event";
import { expandOccurrences, type Occurrence } from "../core/occurrences";
import { startOfDay, addDays, dateKey, startOfWeek, type WeekStartDay, parseLocal } from "../kernel/dates";
import { categoryColor } from "./palette";
import { renderTimeGrid, renderAllDaySection } from "./time-grid";
const DND_TYPE = "application/x-ag2-occ";


const key = dateKey;

export interface ViewDeps {
  onOpen(occ: Occurrence): void;
  today: Date;
  weekStartDay: WeekStartDay;
  anchor: Date;
  onCreateAt(dateKeyStr: string, startHHMM?: string): void;
  onMove(occ: Occurrence, startsAt: string, endsAt: string): void;
  /** 月视图:把日程拖到目标日期(按天平移,保持时刻)。 */
  onMoveToDay(occ: Occurrence, toDay: Date): void;
  /** 本地未同步的日程数(统计页横幅)。 */
  pendingLocal: number;
}

function hhmm(iso: string): string {
  return iso.includes("T") ? iso.slice(11, 16) : t("panel.allDay");
}

function eventRow(occ: Occurrence, deps: ViewDeps, showDate: boolean, highlight?: string): HTMLElement {
  const row = createDiv({ cls: "ag2-event-row" });
  row.style.borderLeftColor = categoryColor(occ.event.category ?? "");
  row.addEventListener("click", () => deps.onOpen(occ));
  const when = createDiv({ cls: "ag2-event-when" + (showDate ? "" : " ag2-when-timeonly") });
  if (showDate) {
    const d = createSpan({ cls: "ag2-event-date", text: dayShort(parseLocal(occ.start), getLang() === "zh") });
    when.appendChild(d);
  }
  const time = createSpan({
    cls: "ag2-event-time",
    text: occ.event.isAllDay ? t("panel.allDay") : occ.end ? `${hhmm(occ.start)}–${hhmm(occ.end)}` : hhmm(occ.start),
  });
  when.appendChild(time);
  row.appendChild(when);
  const main = createDiv({ cls: "ag2-event-main" });
  const title = createDiv({ cls: "ag2-event-title" });
  appendHighlighted(title, occ.event.title, highlight ?? "");
  main.appendChild(title);
  if (occ.event.place) {
    const loc = createDiv({ cls: "ag2-event-place" });
    appendHighlighted(loc, occ.event.place, highlight ?? "");
    main.appendChild(loc);
  }
  row.appendChild(main);
  if (occ.event.status && occ.event.status !== "confirmed") {
    const pill = createSpan({
      cls: "ag2-status-pill" + (occ.event.status === "cancelled" ? " is-cancelled" : ""),
      text: occ.event.status === "tentative" ? t("status.tentative") : t("status.cancelled"),
    });
    row.appendChild(pill);
  }
  if (occ.event.category) {
    const cat = createSpan({ cls: "ag2-cat-pill", text: occ.event.category });
    cat.style.color = categoryColor(occ.event.category);
    cat.style.background = colorSoft(occ.event.category);
    row.appendChild(cat);
  }
  return row;
}

function colorSoft(cat: string): string {
  const c = categoryColor(cat);
  const n = parseInt(c.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},0.15)`;
}

function dayShort(d: Date, zh: boolean): string {
  const w = zh
    ? ["日", "一", "二", "三", "四", "五", "六"][d.getDay()]
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return zh ? `${d.getMonth() + 1}月${d.getDate()}日 周${w}` : `${d.getMonth() + 1}/${d.getDate()} (${w})`;
}

/** ① 日程流:按天分组(今天/明天/日期)。 */
/** 文本高亮:按查询词分段(不区分大小写),命中包 .ag2-mark。 */
function appendHighlighted(el: HTMLElement, text: string, query: string): void {
  const q = query.trim();
  if (!q) {
    el.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const hit = lower.indexOf(ql, i);
    if (hit === -1) {
      el.appendChild(document.createTextNode(text.slice(i)));
      break;
    }
    if (hit > i) el.appendChild(document.createTextNode(text.slice(i, hit)));
    const mark = createSpan({ cls: "ag2-mark", text: text.slice(hit, hit + q.length) });
    el.appendChild(mark);
    i = hit + q.length;
  }
}

export function renderAgendaStream(container: HTMLElement, events: CalendarEvent[], deps: ViewDeps, today: Date, highlight?: string): void {
  const occs = expandOccurrences(events, startOfDay(today), addDays(startOfDay(today), 60));
  const byDay = new Map<string, Occurrence[]>();
  for (const o of occs) {
    const k = key(parseLocal(o.start));
    const list = byDay.get(k) ?? [];
    list.push(o);
    byDay.set(k, list);
  }
  if (byDay.size === 0) {
    container.createDiv({ cls: "ag2-empty", text: t("panel.searchNoResults") });
    return;
  }
  const tomorrowK = key(addDays(startOfDay(today), 1));
  for (const [k, list] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const group = container.createDiv({ cls: "ag2-daygroup" });
    const label = k === key(startOfDay(today)) ? t("panel.today") : k === tomorrowK ? t("panel.tomorrow") : dayShort(parseLocal(k), getLang() === "zh");
    const header = group.createDiv({ cls: "ag2-dayheader" });
    header.createDiv({ cls: "ag2-daylabel", text: label });
    header.createDiv({ cls: "ag2-daycount", text: String(list.length) });
    for (const o of list) group.appendChild(eventRow(o, deps, false, highlight));
  }
}

export interface DayExtras {
  /** 渲染侧栏迷你日历(双月),由面板提供事件圆点数据。 */
  renderMiniCal(side: HTMLElement): void;
}

/** ② 日视图:侧栏迷你日历(双月导航)+ 全天区 + 时间网格。 */
export function renderDayView(container: HTMLElement, events: CalendarEvent[], deps: ViewDeps, extras: DayExtras): void {
  const layout = container.createDiv({ cls: "ag2-daylayout" });
  const main = layout.createDiv({ cls: "ag2-daymain" });
  const side = layout.createDiv({ cls: "ag2-dayside" });
  extras.renderMiniCal(side);
  const from = startOfDay(deps.anchor);
  const occs = expandOccurrences(events, from, addDays(from, 1));
  const grid = main.createDiv({ cls: "ag2-timegrid" });
  renderTimeGrid(grid, occs.filter((o) => !o.event.isAllDay), [deps.anchor], deps, (g) => {
    renderAllDaySection(g, occs.filter((o) => o.event.isAllDay), [deps.anchor], deps);
  });
}


/** ③ 周视图:七列时间网格。 */
export function renderWeekView(container: HTMLElement, events: CalendarEvent[], deps: ViewDeps): void {
  const from = startOfWeek(deps.anchor, deps.weekStartDay);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const occs = expandOccurrences(events, from, addDays(from, 7));
  // 所有定时日程按日裁剪后直接进网格(跨零点片段各画各的等高块,Apple/Ogenda 行为)
  const timed = occs.filter((o) => !o.event.isAllDay);
  const grid = container.createDiv({ cls: "ag2-timegrid" });
  renderTimeGrid(grid, timed, days, deps, (g) => {
    renderAllDaySection(g, occs.filter((o) => o.event.isAllDay), days, deps);
  });
}

/** ④ 月视图:六行七列网格,事件以小条呈现。 */
export function renderMonthView(container: HTMLElement, events: CalendarEvent[], deps: ViewDeps): void {
  const a = deps.anchor;
  const first = new Date(a.getFullYear(), a.getMonth(), 1);
  const gridStart = startOfWeek(first, deps.weekStartDay);
  const labels = t("weekday.short").split(",");
  const head = container.createDiv({ cls: "ag2-monthhead" });
  const dow0 = deps.weekStartDay === 0 ? 0 : 1;
  for (let i = 0; i < 7; i++) head.createDiv({ cls: "ag2-monthdow", text: labels[(dow0 + i) % 7] });
  const grid = container.createDiv({ cls: "ag2-monthgrid" });
  const occs = expandOccurrences(events, gridStart, addDays(gridStart, 42));
  const byDay = new Map<string, Occurrence[]>();
  for (const o of occs) {
    const k = key(parseLocal(o.start));
    const list = byDay.get(k) ?? [];
    list.push(o);
    byDay.set(k, list);
  }
  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    const cell = grid.createDiv({ cls: "ag2-monthcell" });
    if (day.getMonth() !== a.getMonth()) cell.addClass("is-other");
    if (key(day) === key(deps.today)) cell.addClass("is-today");
    const num = cell.createDiv({ cls: "ag2-monthday", text: String(day.getDate()) });
    if (key(day) === key(deps.anchor)) num.addClass("is-selected");
    const list = byDay.get(key(day)) ?? [];
    for (const [idx, o] of list.entries()) {
      const pill = cell.createDiv({ cls: "ag2-monthpill" });
      // 配色走 CSS 变量:--pill-c 驱动胶囊左边框/背景(styles.css .ag2-monthpill)
      pill.style.setProperty("--pill-c", categoryColor(o.event.category ?? ""));
      // HTML5 拖拽:胶囊可拖,uid 随 dataTransfer 传递;格子侧 dragover/drop 接收
      if (idx >= 3) pill.addClass("is-extra");
      pill.draggable = true;
      pill.addEventListener("dragstart", (e) => {
        const dt = e.dataTransfer;
        if (dt) {
          // 重复事件同 id 多实例:键带上实例起始时刻,drop 侧精确反查
          dt.setData(DND_TYPE, `${o.event.id}|${o.start}`);
          dt.effectAllowed = "move";
        }
        pill.classList.add("is-dragging");
      });
      pill.addEventListener("dragend", () => pill.classList.remove("is-dragging"));
      pill.textContent = o.event.isAllDay ? o.event.title : `${hhmm(o.start)} ${o.event.title}`;
      pill.addEventListener("click", (e) => {
        e.stopPropagation(); // 不能冒泡到空白格的“新建”处理
        deps.onOpen(o);
      });
    }
    const extra = list.length - 3;
    if (extra > 0) {
      const more = cell.createDiv({ cls: "ag2-monthmore", text: `+${extra}` });
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        const opening = !cell.classList.contains("ag2-month-open");
        cell.classList.toggle("ag2-month-open", opening);
        more.setText(opening ? t("month.collapse") : `+${extra}`);
      });
    }
    if (deps.onMoveToDay) {
      cell.addEventListener("dragover", (e) => {
        if (e.dataTransfer?.types.includes(DND_TYPE)) {
          e.preventDefault();
          cell.classList.add("ag2-month-drop");
        }
      });
      cell.addEventListener("dragleave", () => cell.classList.remove("ag2-month-drop"));
      cell.addEventListener("drop", (e) => {
        cell.classList.remove("ag2-month-drop");
        const dragKey = e.dataTransfer?.getData(DND_TYPE);
        const occ = dragKey
          ? [...byDay.values()].flat().find((x) => `${x.event.id}|${x.start}` === dragKey) ??
            [...byDay.values()].flat().find((x) => x.event.id === dragKey)
          : undefined;
        if (occ) {
          e.preventDefault();
          deps.onMoveToDay(occ, day);
        }
      });
    }
    cell.addEventListener("click", () => deps.onCreateAt(key(day)));
  }
}

/** ⑤ 统计:总览 hero + 分类排行 + 时间形态 + 最忙日子。 */
export function renderStatsView(container: HTMLElement, events: CalendarEvent[], deps: ViewDeps): void {
  if (deps.pendingLocal > 0) {
    // 待同步横幅:本地有未同步改动时,在所有卡片之前置顶提醒
    container.createDiv({ cls: "ag2-stat-warnbanner", text: t("stats.pendingBanner", { n: deps.pendingLocal }) });
  }
  const from = new Date(deps.anchor.getFullYear(), deps.anchor.getMonth(), 1);
  const to = addDays(new Date(deps.anchor.getFullYear(), deps.anchor.getMonth() + 1, 1), 0);
  const occs = expandOccurrences(events, from, to);
  const used = new Map<string, CalendarEvent>();
  for (const o of occs) used.set(o.event.id, o.event);
  const evs = [...used.values()];
  const total = evs.length;
  const allday = evs.filter((e) => e.isAllDay).length;
  const timed = total - allday;
  const recurring = evs.filter((e) => e.repeats).length;
  const byCat = new Map<string, number>();
  for (const e of evs) {
    const c = e.category ?? "";
    byCat.set(c, (byCat.get(c) ?? 0) + 1);
  }
  const byDayMap = new Map<string, number>();
  for (const o of occs) {
    const k = key(parseLocal(o.start));
    byDayMap.set(k, (byDayMap.get(k) ?? 0) + 1);
  }
  const busiest = [...byDayMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  void to;

  const card = (title?: string): HTMLElement => {
    const c = container.createDiv({ cls: "ag2-stat-card" });
    if (title) c.createDiv({ cls: "ag2-stat-title", text: title });
    return c;
  };

  const hero = card(t("stats.overview"));
  const heroRow = hero.createDiv({ cls: "ag2-hero" });
  heroRow.createDiv({ cls: "ag2-hero-num", text: String(total) });
  heroRow.createDiv({ cls: "ag2-hero-sub", text: `${t("stats.allday")} ${allday} · ${t("stats.timed")} ${timed} · ${t("stats.recurring")} ${recurring}` });
  const ratio = hero.createDiv({ cls: "ag2-ratio" });
  const segA = ratio.createDiv({ cls: "ag2-ratio-seg" });
  segA.style.width = `${total ? (allday / total) * 100 : 0}%`;
  const segB = ratio.createDiv({ cls: "ag2-ratio-seg" });
  segB.style.width = `${total ? (timed / total) * 100 : 0}%`;

  const catCard = card(t("stats.categoryDist"));
  const catRows = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(1, ...catRows.map(([, n]) => n));
  for (const [name, n] of catRows) {
    const row = catCard.createDiv({ cls: "ag2-bar" });
    row.createDiv({ cls: "ag2-bar-label", text: name || "—" });
    const track = row.createDiv({ cls: "ag2-bar-track" });
    const fill = track.createDiv({ cls: "ag2-bar-fill" });
    fill.style.width = `${(n / catMax) * 100}%`;
    fill.style.background = categoryColor(name);
    row.createDiv({ cls: "ag2-bar-num", text: String(n) });
  }

  const shape = card(t("stats.shape"));
  const bar = (label: string, n: number, color: string) => {
    const row = shape.createDiv({ cls: "ag2-bar" });
    row.createDiv({ cls: "ag2-bar-label", text: label });
    const track = row.createDiv({ cls: "ag2-bar-track" });
    const fill = track.createDiv({ cls: "ag2-bar-fill" });
    fill.style.width = `${total ? Math.max(3, (n / total) * 100) : 3}%`;
    fill.style.background = color;
    row.createDiv({ cls: "ag2-bar-num", text: String(n) });
  };
  bar(t("stats.allday"), allday, "var(--text-faint)");
  bar(t("stats.timed"), timed, "var(--ag-tint)");
  bar(t("stats.recurring"), recurring, "#af52de");
  bar(t("stats.once"), total - recurring, "#34c759");

  if (busiest.length) {
    const busy = card(t("stats.busiest"));
    const bMax = Math.max(...busiest.map(([, n]) => n));
    for (const [k, n] of busiest) {
      const row = busy.createDiv({ cls: "ag2-bar" });
      row.createDiv({ cls: "ag2-bar-label", text: dayShort(parseLocal(k), getLang() === "zh") });
      const track = row.createDiv({ cls: "ag2-bar-track" });
      const fill = track.createDiv({ cls: "ag2-bar-fill" });
      fill.style.width = `${(n / bMax) * 100}%`;
      row.createDiv({ cls: "ag2-bar-num", text: String(n) });
    }
  }
}
