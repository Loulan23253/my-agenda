import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { t, getLang } from "../l10n/strings";
import type { CalendarEvent } from "../model/event";
import type { Settings } from "../kernel/settings";
import { filterBySearch } from "./search";
import { renderDateStrip } from "./date-strip";
import { renderAgendaStream, renderDayView, renderWeekView, renderMonthView, renderStatsView } from "./views";
import { isAtToday, formatTitle, addDays, startOfDay, dateKey, parseLocal, startOfWeek } from "../kernel/dates";
import { renderMiniCal } from "./mini-cal";
import type { WeekStartDay } from "../kernel/dates";
import { expandOccurrences, type Occurrence } from "../core/occurrences";
import { askChoice } from "./modals";
const pad = (n: number) => String(n).padStart(2, "0");

export const PANEL_VIEW_TYPE = "myagenda-v2-panel";
export type SyncStatus = "idle" | "busy" | "ok" | "fail";

export interface PanelContext {
  loadEvents(): Promise<CalendarEvent[]>;
  settings(): Settings;
  syncNow(): void | Promise<void>;
  syncStatus(): SyncStatus;
  /** 保存单条(新建/编辑整条);列表里多条一起保存(重复实例拆分)。 */
  saveEvents(events: CalendarEvent[]): void | Promise<void>;
  /** 打开编辑器:existing=null 为新建;defaultStartHHMM 提供默认开始时刻(HH:MM)。 */
  openEditor(existing: CalendarEvent | null, defaultDate: string, defaultStartHHMM?: string, defaultEndHHMM?: string, afterSave?: (ev: CalendarEvent) => Promise<void>): void;
  /** 本地未同步日程数。 */
  pendingLocal(): number;
  /** 视图内拖拽移动日程块后的结果回传(ISO 字符串)。 */
  onMove(occ: Occurrence, startsAt: string, endsAt: string): void;
  /** 月视图:把日程拖放到目标日期。 */
  onMoveToDay(occ: Occurrence, toDay: Date): void;
  provider(): string;
  today(): Date;
}

type Tab = "agenda" | "day" | "week" | "month" | "stats";

export class AgendaPanelView extends ItemView {
  private tab: Tab = "agenda";
  private anchor: Date;
  private searchQuery = "";
  private searchFocused = false;
  private hiddenCats = new Set<string>();
  private nowTimer: number | null = null;
  private searchDebounce: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: PanelContext,
  ) {
    super(leaf);
    this.anchor = this.today();
  }

  private today(): Date {
    return this.ctx.today();
  }
  private weekStartDay(): WeekStartDay {
    return this.ctx.settings().weekStart;
  }

  getViewType(): string {
    return PANEL_VIEW_TYPE;
  }
  getDisplayText(): string {
    return t("panel.title");
  }
  getIcon(): string {
    return "calendar-days";
  }

  async onOpen(): Promise<void> {
    await this.render();
    // "现在"红线每分钟刷新(仅日/周视图有时刻网格)
    this.nowTimer = window.setInterval(() => {
      if (this.tab === "day" || this.tab === "week") this.repositionNowLine();
    }, 30_000);
  }
  async onClose(): Promise<void> {
    if (this.nowTimer !== null) {
      window.clearInterval(this.nowTimer);
      this.nowTimer = null;
    }
    if (this.searchDebounce !== null) {
      window.clearTimeout(this.searchDebounce);
      this.searchDebounce = null;
    }
    await super.onClose();
  }

  /** 把"现在"红线/红点位置刷新到当前分钟(窗口固定 0–24)。 */
  private repositionNowLine(): void {
    const now = new Date();
    // 精确到秒:过渡动画下每 30 秒的红线滑动是连续可感的
    const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const top = (nowMin / (24 * 60)) * 100 + "%";
    for (const line of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".ag2-nowline"))) {
      line.style.top = top;
    }
  }
  rerender(): void {
    void this.render();
  }

  /** 点击日程:重复事件先问编辑范围;普通事件直接编辑。 */
  private async openOccurrenceEditor(occ: Occurrence): Promise<void> {
    const master = occ.event;
    if (!master.repeats?.rule) {
      this.ctx.openEditor(master, dateKey(parseLocal(occ.start)));
      return;
    }
    const pick = await askChoice(this.app, t("recurrence.choice"), [
      { label: t("recurrence.series"), value: "series" },
      { label: t("recurrence.single"), value: "single" },
    ]);
    if (pick === "series") {
      this.ctx.openEditor(master, dateKey(parseLocal(occ.start)));
      return;
    }
    if (pick === "single") {
      // 与主系列共用 UID，以 RECURRENCE-ID 保存单次修改；一次保存即可更新主系列。
      const override: CalendarEvent = {
        ...master,
        recurrenceId: occ.start,
        repeats: undefined,
        recurrenceOverrides: undefined,
        skippedDates: undefined,
        startsAt: occ.start,
        endsAt: occ.end,
      };
      this.ctx.openEditor(override, dateKey(parseLocal(occ.start)));
    }
  }

  /** 箭头步进粒度跟随当前视图:日/日程 ±1 天,周 ±1 周,月/统计 ±1 月。 */
  private shiftAnchor(dir: 1 | -1): void {
    if (this.tab === "week") this.anchor = addDays(this.anchor, dir * 7);
    else if (this.tab === "month" || this.tab === "stats") {
      const m = this.anchor.getMonth() + dir;
      const dim = new Date(this.anchor.getFullYear(), m + 1, 0).getDate();
      this.anchor = new Date(this.anchor.getFullYear(), m, Math.min(this.anchor.getDate(), dim));
    } else this.anchor = addDays(this.anchor, dir);
  }

  /** 搜索输入时只重建结果区(strip/筛选/视图),头部与搜索行保持不动。 */
  private async renderResultsOnly(): Promise<void> {
    // strip 被移出 results 挂在 contentEl 下(视觉置顶),重渲染时必须手动清掉,否则逐次累积
    this.contentEl.querySelectorAll(".ag2-strip-host").forEach((el) => el.remove());
    const results = this.contentEl.querySelector<HTMLElement>(".ag2-results");
    if (!results) return void this.render();
    results.empty();
    await this.buildResults(results);
  }

  private async buildResults(results: HTMLElement): Promise<void> {
    const body = results.createDiv({ cls: "ag2-body" });

    // 视图回调:重复事件先问"整条/仅此实例"

    try {
      // 今日进度:日视图顶部显示"已过 x/全部 n"(完整时间戳比较:全天/跨零点事件不算已过)
      if (this.tab === "day") {
        const all = await this.ctx.loadEvents();
        const from = startOfDay(this.today());
        const todays = expandOccurrences(all, from, addDays(from, 1));
        if (todays.length > 0) {
          const now = this.today().getTime();
          const passed = todays.filter((o) => parseLocal(o.end ?? o.start).getTime() <= now).length;
          const bar = results.createDiv({ cls: "ag2-todayprogress" });
          bar.createDiv({ cls: "ag2-todayprogress-fill" }).style.width = `${Math.round((passed / todays.length) * 100)}%`;
          bar.createDiv({ cls: "ag2-todayprogress-label", text: `${passed}/${todays.length}` });
        }
      }
      const events = filterBySearch(await this.ctx.loadEvents(), this.searchQuery);
      const wsd = this.weekStartDay();
      const stripWeekStart = startOfWeek(this.anchor, wsd);
      if (this.tab !== "month") {
      const stripOccs = expandOccurrences(events, stripWeekStart, addDays(stripWeekStart, 7));
      const stripRow = results.createDiv({ cls: "ag2-strip-host" });
      renderDateStrip(stripRow, {
        anchor: this.anchor,
        today: this.today(),
        weekStartDay: wsd,
        eventDays: new Set(stripOccs.map((o) => dateKey(parseLocal(o.start)))),
        onSelect: (day) => {
          this.anchor = day;
          if (this.tab !== "day" && this.tab !== "agenda") this.tab = "day";
          void this.render();
        },
      });
      this.contentEl.insertBefore(stripRow, this.contentEl.querySelector(".ag2-search") ?? results);
      }

      // 分类筛选:只展示"启用日历"的分类(按日历顺序);未配置分类的日历不产生胶囊
      const cats: string[] = [];
      for (const c of this.ctx.settings().calendars ?? []) {
        if (!c.enabled || !c.category.trim()) continue;
        if (!cats.includes(c.category.trim())) cats.push(c.category.trim());
      }
      if (cats.length === 0) {
        for (const e of events) {
          const cat = (e.category ?? "").trim();
          if (cat && !cats.includes(cat)) cats.push(cat);
        }
        cats.sort((a, b) => a.localeCompare(b));
      }
      for (const c of [...this.hiddenCats]) if (!cats.includes(c)) this.hiddenCats.delete(c);
      // 分类筛选:隐藏选中分类;无分类事件不参与筛选,始终显示
      const shown =
        cats.length >= 2 && this.hiddenCats.size > 0
          ? events.filter((e) => {
              const cat = (e.category ?? "").trim();
              return cat === "" || !this.hiddenCats.has(cat);
            })
          : events;

      if (cats.length >= 2) {
        const bar = results.createDiv({ cls: "ag2-filter" });
        const chip = (label: string, off: boolean, onClick: () => void) => {
          const el = bar.createDiv({ cls: "ag2-chip" + (off ? " off" : ""), text: label });
          el.addEventListener("click", onClick);
        };
        chip(t("panel.filterAll"), this.hiddenCats.size === 0, () => {
          this.hiddenCats.clear();
          void this.render();
        });
        for (const c of cats) {
          chip(c, this.hiddenCats.has(c), () => {
            if (this.hiddenCats.has(c)) this.hiddenCats.delete(c);
            else this.hiddenCats.add(c);
            void this.render();
          });
        }
        results.insertBefore(bar, body);
      }

      const deps = {
        onOpen: (occ: Occurrence) => void this.openOccurrenceEditor(occ),
        today: this.today(),
        weekStartDay: this.weekStartDay(),
        anchor: this.anchor,
        onCreateAt: (dateKeyStr: string, startHHMM?: string, endHHMM?: string) => this.ctx.openEditor(null, dateKeyStr, startHHMM, endHHMM),
        onMove: (occ: Occurrence, startsAt: string, endsAt: string) => this.ctx.onMove(occ, startsAt, endsAt),
        onMoveToDay: (occ: Occurrence, toDay: Date) => this.ctx.onMoveToDay(occ, toDay),
        pendingLocal: this.ctx.pendingLocal(),
        onSelectDate: (day: Date) => {
          this.anchor = day;
          this.tab = "day";
          void this.render();
        },
        onShiftMonth: (dir: 1 | -1) => {
          this.anchor = new Date(this.anchor.getFullYear(), this.anchor.getMonth() + dir, 1);
          void this.render();
        },
      };
      const bodyEl = body;
      body.empty();
      if (this.tab === "agenda") renderAgendaStream(bodyEl, shown, deps, this.today(), this.searchQuery);
      else if (this.tab === "day")
        renderDayView(bodyEl, shown, deps, {
          renderMiniCal: (side) => {
            const wsd = this.weekStartDay();
            const from = startOfWeek(new Date(this.anchor.getFullYear(), this.anchor.getMonth() - 1, 1), wsd);
            const to = new Date(this.anchor.getFullYear(), this.anchor.getMonth() + 1, 1);
            const evDays = new Set(expandOccurrences(shown, from, to).map((o) => dateKey(parseLocal(o.start))));
            renderMiniCal(side, {
              anchor: this.anchor,
              today: this.today(),
              weekStartDay: wsd,
              eventDays: evDays,
              months: 2,
              onSelect: (day) => {
                this.anchor = day;
                if (this.tab !== "day") this.tab = "day";
                void this.render();
              },
            });
          },
        });
      else if (this.tab === "week") renderWeekView(bodyEl, shown, deps);
      else if (this.tab === "month") renderMonthView(bodyEl, shown, deps);
      else renderStatsView(bodyEl, shown, deps);
    } catch (e) {
      results.createDiv({ cls: "ag2-empty", text: String(e) });
    }
  }

  private async render(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("ag2-panel");
    container.parentElement?.addClass("ag2-viewhost"); // 替代 :has 的宿主标记
    const accent = this.ctx.settings().accent;
    if (accent === "theme") container.setCssProps({ "--ag-tint": "var(--interactive-accent)" });
    else if (/^#[0-9a-fA-F]{6}$/.test(accent)) container.setCssProps({ "--ag-tint": accent });
    else container.style.removeProperty("--ag-tint");

    // 大标题栏
    const head = container.createDiv({ cls: "ag2-head" });
    const titlebar = head.createDiv({ cls: "ag2-titlebar" });

    // 步进箭头:粒度跟随当前视图(日/日程 ±1 天,周 ±1 周,月/统计 ±1 月)
    const prevBtn = titlebar.createDiv({ cls: "ag2-tb-arrow", text: "‹" });
    prevBtn.addEventListener("click", () => {
      this.shiftAnchor(-1);
      void this.render();
    });

    const lang = getLang();
    titlebar.createDiv({
      cls: "ag2-largetitle",
      text: isAtToday(this.tab, this.anchor, this.today(), this.weekStartDay()) && (this.tab === "agenda" || this.tab === "day")
        ? t("panel.today")
        : formatTitle(this.tab, this.anchor, lang),
    });

    const nextBtn = titlebar.createDiv({ cls: "ag2-tb-arrow", text: "›" });
    nextBtn.addEventListener("click", () => {
      this.shiftAnchor(1);
      void this.render();
    });

    titlebar.createDiv({ cls: "ag2-spacer" });

    // “今天”常驻:任何视图任何日期都可一键回到今天
    const jump = titlebar.createDiv({ cls: "ag2-navtoday-btn", text: t("panel.today") });
    jump.addEventListener("click", () => {
      this.anchor = this.today();
      void this.render();
    });

    const syncBtn = titlebar.createDiv({ cls: "ag2-syncbtn" });
    setIcon(syncBtn, "refresh-cw");
    const st = this.ctx.syncStatus();
    const ls = this.ctx.settings().lastSync;
    let label = st === "busy" ? t("panel.syncing") : st === "ok" ? t("panel.syncSuccess") : st === "fail" ? t("panel.syncError") : t("panel.sync");
    if (ls && st !== "busy") {
      const d = new Date(ls.at);
      label = (ls.ok ? "" : "⚠") + label + ` · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    if (st === "busy") syncBtn.addClass("is-busy");
    syncBtn.createSpan({ text: label });
    // 未配置同步源(provider=none)时禁用:置灰且不响应点击
    if (this.ctx.provider() === "none") syncBtn.addClass("ag2-disabled");
    else syncBtn.addEventListener("click", () => void this.ctx.syncNow());

    const fab = titlebar.createDiv({ cls: "ag2-fab" });
    setIcon(fab, "plus");
    fab.setAttr("aria-label", t("panel.newEvent"));
    fab.addEventListener("click", () => {
      this.ctx.openEditor(null, dateKey(this.anchor));
    });

    // 搜索行(常驻;日期条与筛选条在加载后插到它之前)
    const searchRow = container.createDiv({ cls: "ag2-search" });
    const searchInput = searchRow.createEl("input", { type: "search", cls: "ag2-searchinput", value: this.searchQuery });
    searchInput.placeholder = t("panel.searchPlaceholder");
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      this.searchFocused = true;
      // 180ms 节流:连续击键只触发最后一次重建
      if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce);
      this.searchDebounce = window.setTimeout(() => {
        this.searchDebounce = null;
        if (this.contentEl.isConnected) void this.renderResultsOnly();
      }, 180);
    });
    searchInput.addEventListener("blur", () => {
      this.searchFocused = false;
    });
    if (this.searchFocused) {
      window.requestAnimationFrame(() => {
        searchInput.focus();
        const len = searchInput.value.length;
        searchInput.setSelectionRange(len, len);
      });
    }

    // 结果区包裹层:搜索时只重建这一层(strip/筛选/视图),头部与搜索行不动
    const results = container.createDiv({ cls: "ag2-results" });
    void this.buildResults(results);

    // 底部导航
    const navbar = container.createDiv({ cls: "ag2-navbar" });
    const items: { key: Tab; icon: string; label: string }[] = [
      { key: "agenda", icon: "list", label: t("tab.agenda") },
      { key: "day", icon: "clock", label: t("tab.day") },
      { key: "week", icon: "calendar-range", label: t("tab.week") },
      { key: "month", icon: "calendar-days", label: t("tab.month") },
      { key: "stats", icon: "activity", label: t("tab.stats") },
    ];
    for (const item of items) {
      const el = navbar.createDiv({ cls: "ag2-navitem" + (this.tab === item.key ? " active" : "") });
      setIcon(el, item.icon);
      el.createDiv({ cls: "ag2-navitem-label", text: item.label });
      el.addEventListener("click", () => {
        this.tab = item.key;
        void this.render();
      });
    }
  }
}

