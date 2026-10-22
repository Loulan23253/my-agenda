import { Plugin, Notice, WorkspaceLeaf, TFile, TAbstractFile, MarkdownRenderChild, MarkdownView, editorInfoField } from "obsidian";
import * as obsidianModule from "obsidian";
import { setLang, t } from "./l10n/strings";
import { sanitize, type Settings } from "./kernel/settings";
import { SettingsTab } from "./kernel/settings-tab";
import { VaultFileIO } from "./platform/io";
import { MonthlyNoteStore, monthOf } from "./data/note-store";
import { EMPTY_JOURNAL, journalRemove, type SyncJournal } from "./data/journal";
import type { KeyValueFileIO } from "./data/io";
import { obsidianHttp, discoverCalendars } from "./sync/dav";
import { SyncEngine, type CalendarRoute } from "./sync/engine";
import { parseIcsToEvents } from "./sync/ical";
import { buildIcs } from "./core/ics-export";
import { expandOccurrences, type Occurrence } from "./core/occurrences";
import { parseLocal as parseLocalDate } from "./kernel/dates";
import { AgendaPanelView, PANEL_VIEW_TYPE, type SyncStatus } from "./ui/panel";
import {  askConflict, openSyncHistory, askChoice, openEventEditor , openDiscoverModal } from "./ui/modals";
import { QuickAddModal } from "./ui/quick-add-modal";
import { applyInjection, buildInjectList, listInjectedTasks, listSkippedTasks, skipInjectedTask, restoreSkippedTask } from "./ui/inject";
import { observeInjectedPreview, injectionEditorExtension, type InjectionActions } from "./ui/inject-controls";
import { updateEditorText } from "./ui/editor-update";
import type { Editor } from "obsidian";
import { dueReminders } from "./kernel/reminders";
import { stripLegacyFromDaily, stripLegacyFromMonthly } from "./data/legacy-clean";
import { planRecurringMove, type RecurMovePick } from "./core/recurrence-move";
import { setCategoryColors } from "./ui/palette";
import { dateKey, startOfDay, addDays, parseLocal } from "./kernel/dates";
import { rebaseRuleOnMove } from "./core/recurrence-rebase";
import { shiftIsoDays } from "./kernel/dates";
import type { CalendarEvent } from "./model/event";


export default class MyAgendaPluginV2 extends Plugin {
  settings!: Settings;
  private io!: KeyValueFileIO;
  private notes!: MonthlyNoteStore;
  private storageFolder = "";
  private journal: SyncJournal = EMPTY_JOURNAL;
  private cache: { events: CalendarEvent[] } | null = null;
  private syncInFlight = false;
  private syncState: SyncStatus = "idle";
  private firedReminders = new Set<string>();
  private autoSyncTimer: number | null = null;

  async onload(): Promise<void> {
    this.settings = sanitize(await this.loadData());
    this.io = new VaultFileIO(this.app.vault, this.app.fileManager);
    this.storageFolder = this.settings.folder;
    this.notes = new MonthlyNoteStore(this.io, this.storageFolder);
    await this.loadJournal();
    setLang(this.resolveLang());
    setCategoryColors(this.settings.categoryColors);
    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerInjectionControls();

    this.registerView(PANEL_VIEW_TYPE, (leaf: WorkspaceLeaf) =>
      new AgendaPanelView(leaf, {
        loadEvents: () => this.loadEvents(),
        settings: () => this.settings,
        syncNow: () => void this.syncNow(),
        syncStatus: () => this.syncState,
        saveEvents: (events) => this.saveEventsList(events),
        onMove: (occ: Occurrence, startsAt: string, endsAt: string) =>
          void this.onMoveEvent(occ, startsAt, endsAt),
        onMoveToDay: (occ: Occurrence, toDay: Date) => void this.onMoveToDay(occ, toDay),
        openEditor: (existing, defaultDate, defaultStartHHMM, defaultEndHHMM, afterSave) =>
          openEventEditor(
            this.app,
            existing,
            defaultDate,
            async (ev) => {
              await this.saveEventsList([ev]);
              if (afterSave) await afterSave(ev);
            },
            existing
              ? (ev) => this.deleteEvent(ev)
              : undefined,
            { defaultCategory: this.settings.defaultCategory, defaultReminderMinutes: this.settings.defaultReminderMinutes, categories: this.enabledCalendarCategories() },
            defaultStartHHMM,
          ),
        pendingLocal: () => this.pendingLocalCount(),
        provider: () => this.settings.provider,
        today: () => new Date(),
      }),
    );

    this.addRibbonIcon("calendar-days", t("cmd.openPanel"), () => void this.openPanel());
    this.addCommand({ id: "open-panel", name: t("cmd.openPanel"), callback: () => void this.openPanel() });
    this.addCommand({ id: "sync-now", name: t("cmd.sync"), callback: () => void this.syncNow() });
    this.addCommand({ id: "audit-sync", name: "检查日历同步（只读）", callback: () => void this.auditSync() });
    this.addCommand({ id: "inject-daily", name: t("cmd.inject"), callback: () => void this.injectCommand() });
    this.addCommand({ id: "skip-injected-task", name: t("cmd.skipInjected"), callback: () => void this.changeInjectedTask("skip") });
    this.addCommand({ id: "restore-injected-task", name: t("cmd.restoreInjected"), callback: () => void this.changeInjectedTask("restore") });
    this.addCommand({
      id: "clear-calendar-local",
      name: t("cmd.clearLocal"),
      callback: async () => {
        const cals = this.settings.calendars;
        if (!cals.length) {
          new Notice(t("notice.clearNone"));
          return;
        }
        const pick = await askChoice(
          this.app,
          t("cmd.clearLocal.title"),
          cals.map((c) => ({ value: c.id, label: c.enabled ? (c.name || c.id) : "[已停] " + (c.name || c.id) })),
        );
        if (!pick) return;
        const cal = cals.find((c) => c.id === pick);
        if (!cal) return;
        const confirm = await askChoice(
          this.app,
          t("settings.cal.disable.title", { name: cal.name || cal.id }),
          [{ value: "clear", label: t("settings.cal.disable.clear") }],
        );
        if (!confirm) return;
        await this.clearCalendarLocalEvents(cal);
      },
    });
    this.addCommand({
      id: "reset-sync-data",
      name: t("cmd.reset"),
      callback: async () => {
        const confirm = await askChoice(this.app, t("settings.reset.confirm"), [
          { value: "reset", label: t("settings.reset.confirmYes") },
        ]);
        if (!confirm) return;
        await this.resetAllSyncData();
      },
    });
    this.addCommand({
      id: "quick-add",
      name: t("cmd.quickAdd"),
      callback: () =>
        new QuickAddModal(this.app, {
          onSave: (ev) => void this.saveEventsList([ev]),
          defaults: { defaultCategory: this.settings.defaultCategory, defaultReminderMinutes: this.settings.defaultReminderMinutes, categories: this.enabledCalendarCategories() },
        }).open(),
    });

    this.registerEvent(this.app.vault.on("create", (f) => void this.onFileCreate(f)));
    this.registerEvent(
      this.app.vault.on("modify", (f) => this.touchCache(f.path)),
    );
    this.registerEvent(this.app.vault.on("delete", (f) => this.touchCache(f.path)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => { this.touchCache(f.path); this.touchCache(old); }));

    this.register(() => this.stopAutoSync());
    this.restartAutoSync();
    // 提醒轮询由 startReminderPolling 的 60s 定时器统一负责(此前双定时器并存,重复展开浪费)
    this.app.workspace.onLayoutReady(() => {
      this.startReminderPolling(); void this.catchUpInjection();
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view instanceof MarkdownView && leaf.view.file && /^\d{4}-\d{2}-\d{2}\.md$/.test(leaf.view.file.name) && this.inInjectScope(leaf.view.file.path)) {
          leaf.view.previewMode.rerender(true);
          leaf.view.editor.refresh();
        }
      }
    });
  }

  private resolveLang(): "zh" | "en" {
    if (this.settings.lang !== "auto") return this.settings.lang;
    // auto = 跟随 Obsidian 界面语言(而不是系统语言):Obsidian 界面设为英文时必须出英文。
    // getLanguage() 是 1.9+ API,动态探测存在才用;再依次回退 localStorage 与系统语言。
    const getLangApi = (obsidianModule as unknown as { getLanguage?: () => string }).getLanguage;
    if (typeof getLangApi === "function") {
      const lang = getLangApi();
      if (lang) return lang.toLowerCase().startsWith("zh") ? "zh" : "en";
    }
    try {
      const obsidianLang = window.localStorage.getItem("language");
      if (obsidianLang) return obsidianLang.toLowerCase().startsWith("zh") ? "zh" : "en";
    } catch {
      /* popout 窗口无 localStorage */
    }
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  private registerInjectionControls(): void {
    const actions: InjectionActions = {
      marker: () => this.settings.injectMarker,
      eligible: (path) => /^\d{4}-\d{2}-\d{2}\.md$/.test(path.split("/").pop() ?? "") && this.inInjectScope(path),
      skip: async (path, key) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await this.changeInjectedTask("skip", key, file);
      },
      restore: async (path, key) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await this.changeInjectedTask("restore", key, file);
      },
    };
    this.registerEditorExtension(injectionEditorExtension(actions, (view) => view.state.field(editorInfoField, false)?.file?.path));
    const children = new Set<MarkdownRenderChild>();
    let live = true;
    this.register(() => { live = false; for (const child of children) child.unload(); children.clear(); });
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      if (!live || !actions.eligible(ctx.sourcePath)) return;
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!(file instanceof TFile)) return;
      const source = await this.app.vault.cachedRead(file);
      if (!source.includes(this.settings.injectMarker)) return;
      const section = ctx.getSectionInfo(el);
      if (!live || (!section && !el.matches('li, .task-list-item, .callout') && !el.querySelector('li, .task-list-item, .callout'))) return;
      const cleanup = observeInjectedPreview(el, source, file.path, section, actions);
      const child = new MarkdownRenderChild(el);
      children.add(child);
      child.register(() => { cleanup(); children.delete(child); });
      ctx.addChild(child);
    }, 1000);
  }

  private touchCache(path: string): void {
    if (path === this.settings.folder || path.startsWith(this.settings.folder + "/")) {
      this.cache = null;
      // 外部改动(iCloud/Sync/手改)后节流刷新常开面板,避免显示陈旧数据
      if (!this.touchRefreshTimer) {
        this.touchRefreshTimer = window.setTimeout(() => {
          this.touchRefreshTimer = null;
          this.refreshPanels();
        }, 600);
      }
    }
  }
  private touchRefreshTimer: number | null = null;

  private journalPath(): string {
    return `${this.storageFolder}/.myagenda/journal.json`;
  }

  private async loadJournal(): Promise<void> {
    const text = await this.io.readText(this.journalPath());
    if (!text) {
      this.journal = { ...EMPTY_JOURNAL, events: {}, calendars: {} };
      return;
    }
    try {
      const parsed = JSON.parse(text) as SyncJournal;
      this.journal = parsed?.version === 2 && parsed.events ? parsed : { ...EMPTY_JOURNAL, events: {}, calendars: {} };
    } catch {
      this.journal = { ...EMPTY_JOURNAL, events: {}, calendars: {} };
    }
  }

  private async saveJournal(): Promise<void> {
    await this.io.writeText(this.journalPath(), JSON.stringify(this.journal, null, 2));
  }

  private loadEvents(): Promise<CalendarEvent[]> {
    // 记忆化:v1 的教训——切视图不该每轮全量读盘;失效由文件事件/写入/同步驱动
    if (this.cache) return Promise.resolve(this.cache.events);
    return this.notes.loadAll().then((r) => {
      this.cache = { events: r.events };
      if (r.skipped > 0) new Notice(`${r.skipped} 个日程块无法解析,已跳过`);
      return r.events;
    });
  }

  private invalidate(): void {
    this.cache = null;
  }

  private async openPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE);
    if (existing.length) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: PANEL_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private routes(): CalendarRoute[] {
    if (this.settings.provider !== "icloud" && this.settings.provider !== "caldav") return [];
    const auth = { user: this.settings.user, pass: this.settings.password };
    if (!auth.user || !auth.pass) return [];
    return this.settings.calendars
      .filter((c) => c.enabled && c.url)
      .map((c) => ({ id: c.id, url: c.url, name: c.name, category: c.category, auth }));
  }

  private async auditSync(): Promise<void> {
    const reports = await Promise.all(this.routes().map(async (route) => {
      try {
        const result = await obsidianHttp({
          url: route.url, method: "REPORT",
          headers: { Authorization: "Basic " + btoa(`${route.auth.user}:${route.auth.pass}`), Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
          body: '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>',
        });
        const elements = Array.from(new DOMParser().parseFromString(result.text, "application/xml").getElementsByTagName("*"));
        let events = 0;
        const diagnostics = { skipped: 0 };
        for (const el of elements.filter(e => e.localName === "calendar-data")) events += parseIcsToEvents(el.textContent || "", "", diagnostics).length;
        if (result.status >= 200 && result.status < 300) await this.io.writeText(`${this.storageFolder}/.myagenda/recovery/${route.id}.xml`, result.text);
        return { calendar: route.name, status: result.status, bytes: result.text.length, resources: elements.filter(e => e.localName === "response").length, events, skipped: diagnostics.skipped };
      } catch (error) { return { calendar: route.name, error: error instanceof Error ? error.message : String(error) }; }
    }));
    await this.io.writeText(`${this.storageFolder}/.myagenda/connection-check.json`, JSON.stringify({ at: new Date().toISOString(), reports }, null, 2));
    new Notice("只读检查完成，结果已保存到日程文件夹的 .myagenda/connection-check.json", 10000);
  }

  private async syncNow(manual = true): Promise<void> {
    if (this.syncInFlight) {
      new Notice(t("notice.syncRunning"));
      return;
    }
    const routes = this.routes();
    const isIcs = this.settings.provider === "ics" && this.settings.icsUrl;
    if (this.settings.provider === "none" || (!routes.length && !isIcs)) {
      new Notice(routes.length === 0 && !isIcs ? t("notice.noProvider") : t("notice.incomplete"));
      return;
    }
    this.syncInFlight = true;
    this.syncState = "busy";
    this.refreshPanels();
    try {
      // 整个目录移动/尚未下载时，不能将读不到的事件作为删除推送到服务器。
      if (Object.keys(this.journal.events).length > 0 && !(await this.app.vault.adapter.exists(this.storageFolder))) {
        throw new Error(`日程存储文件夹不存在：${this.storageFolder}。请先在设置中选择移动后的文件夹。`);
      }
      if (isIcs) {
        const res = await obsidianHttp({ url: this.settings.icsUrl, method: "GET" });
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
        const diagnostics = { skipped: 0 };
        const events = parseIcsToEvents(res.text, "ics", diagnostics);
        await this.writeAll(events, diagnostics.skipped === 0);
        if (diagnostics.skipped) throw new Error(`${diagnostics.skipped} 个订阅日程无法解析，已保留旧日程并暂停删除`);
        this.syncState = "ok";
      } else {
        const engine = new SyncEngine({
          http: obsidianHttp,
          routes,
          notes: this.notes,
          journal: this.journal,
          saveJournal: () => this.saveJournal(),
          // 冲突裁决:仅"手动同步 + 策略为询问"时弹窗;自动同步/静默策略一律服务器赢
          askConflict: async (info) =>
            manual && this.settings.conflictPolicy === "ask"
              ? askConflict(this.app, info)
              : "theirs",
          askCalendarsDeleted: async (names) => {
            const pick = await askChoice(
              this.app,
              `${t("settings.cal.deleted.title")}\n${names.join(", ")}`,
              [{ value: "remove", label: t("settings.cal.deleted.remove") }],
            );
            if (pick !== "remove") return false;
            for (const name of names) {
              const cal = this.settings.calendars.find((x) => (x.name || x.id) === name);
              if (cal) {
                await this.clearCalendarLocalEvents(cal);
                if (this.journal.calendars[cal.id]) delete this.journal.calendars[cal.id];
              }
            }
            this.settings.calendars = this.settings.calendars.filter((x) => !names.includes(x.name || x.id));
            await this.saveSettings();
            this.invalidate();
            return true;
          },
          notify: (m) => new Notice(m, 10000),
          sleep,
        });
        const summary = await withNetworkRetry(() => engine.run());
        if (summary.failed) throw new Error(`${summary.failed} 个日程上传或删除未完成，已保留待同步记录`);
        if (manual && summary.unmapped) new Notice(`${summary.unmapped} 个日程分类未匹配启用日历，已保留在本地；请先选择对应分类再上传`, 10000);
        this.syncState = "ok";
      }
      this.settings.lastSync = { at: new Date().toISOString(), ok: true };
      this.pushSyncHistory(true, "");
    } catch (e) {
      this.syncState = "fail";
      this.settings.lastSync = { at: new Date().toISOString(), ok: false };
      const msg = e instanceof Error ? e.message : String(e);
      this.pushSyncHistory(false, msg);
      new Notice(t("notice.syncFail", { msg }), 10000);
    } finally {
      this.syncInFlight = false;
      await this.saveSettings();
      this.invalidate();
      this.refreshPanels();
      void this.checkReminders();
      if (this.syncState === "ok") void this.refreshTodayInjection();
    }
  }

  /** 全量重写月度文件(ICS 导入等无账本路径使用)。 */
  private async writeAll(events: Awaited<ReturnType<MonthlyNoteStore["loadAll"]>>["events"], removeMissing = true): Promise<void> {
    // ICS 订阅 = 数据源:该月内容以订阅为准,但保留与订阅无关的既有本地日程
    const existing = (await this.notes.loadAll()).events;
    const importedIds = new Set(events.map((e) => e.id));
    const removed = new Set(existing.filter((e) => removeMissing && e.id.startsWith("ics-") && !importedIds.has(e.id)).map((e) => e.id));
    if (removed.size) await this.notes.removeByUids(removed);
    const merged = [...existing.filter((e) => !importedIds.has(e.id) && !removed.has(e.id)), ...events];
    // 月份并集:旧位置与新位置都要重写,否则订阅事件跨月移动后旧块残留
    const months = new Set([...merged.map((e) => monthOf(e.startsAt)), ...existing.map((e) => monthOf(e.startsAt))]);
    for (const m of months) {
      const preamble = await this.notes.readMonthPreamble(m);
      // writeMonth 需要库内全量(其跨月清理按 id 全集判断),传子集会导致旧块残留
      await this.notes.writeMonth(m, merged, preamble);
    }
  }

  /** 保存一批日程(新建/编辑/重复实例拆分),写月度文件 + 账本置脏 + 触发同步。 */
  private async saveEventsList(events: CalendarEvent[]): Promise<void> {
    const all = (await this.notes.loadAll()).events;
    const oldById = new Map(all.map((e) => [e.id, e]));
    const merged = [...all];
    const updatedById = new Map(oldById);
    events = events.map((ev) => {
      const master = updatedById.get(ev.id);
      const updated = ev.recurrenceId && master
        ? { ...master, recurrenceOverrides: [...(master.recurrenceOverrides ?? []).filter((o) => o.recurrenceId !== ev.recurrenceId),
            { ...ev, repeats: undefined, recurrenceOverrides: undefined }] }
        : ev;
      updatedById.set(ev.id, updated);
      return updated;
    });
    for (const ev of events) {
      const idx = merged.findIndex((x) => x.id === ev.id);
      if (idx >= 0) merged[idx] = ev;
      else merged.push(ev);
      const entry = this.journal.events[ev.id];
      if (entry) entry.pushedFingerprint = "dirty";
    }
    // 受影响月份:新位置 + 被移走事件的旧位置(跨月移动不留残留)
    const affected = new Set<string>();
    for (const ev of events) {
      affected.add(monthOf(ev.startsAt));
      const old = oldById.get(ev.id);
      if (old) affected.add(monthOf(old.startsAt));
    }
    for (const month of affected) {
      const preamble = await this.notes.readMonthPreamble(month);
      await this.notes.writeMonth(month, merged, preamble);
    }
    this.invalidate();
    this.refreshPanels();
    await this.refreshTodayInjection();
    void this.syncNow();
  }

  /** 启用日历的分类名(去重,按日历顺序)。 */
  private enabledCalendarCategories(): string[] {
    const out: string[] = [];
    for (const c of this.settings.calendars) {
      if (!c.enabled || !c.category.trim()) continue;
      if (!out.includes(c.category.trim())) out.push(c.category.trim());
    }
    return out;
  }

  /** 拖拽/调整提交:普通事件直接改起止;重复事件按 Apple 语义拆实例,绝不静默改锚点。 */
  private async onMoveEvent(occ: Occurrence, startsAt: string, endsAt: string): Promise<void> {
    const current = (await this.loadEvents()).find((e) => e.id === occ.event.id);
    if (!current) return;
    if (occ.event.recurrenceId) {
      await this.saveEventsList([{ ...occ.event, startsAt, endsAt }]);
      return;
    }
    if (current.repeats?.rule) {
      const occDay = dateKey(parseLocal(occ.start));
      const anchorDay = dateKey(parseLocal(current.startsAt));
      // 拖后续实例 → 只动该实例(原日期 EXDATE + 新位置单次例外),锚点不动;
      // 拖的是锚点实例 → 询问"整个系列 / 仅此实例"
      const pick = occDay === anchorDay
        ? await askChoice(this.app, t("recurrence.choice"), [
            { label: t("recurrence.series"), value: "series" },
            { label: t("recurrence.single"), value: "single" },
          ])
        : "single";
      if (!pick) return;
      await this.saveEventsList(planRecurringMove(current, occ.start, startsAt, endsAt, pick as RecurMovePick));
      return;
    }
    await this.saveEventsList([{ ...current, startsAt, endsAt, isAllDay: current.isAllDay }]);
  }

  /** 月视图拖拽:把日程移到目标日期(按天平移,保持时刻);重复事件按策略处理。 */
  private async onMoveToDay(occ: Occurrence, toDay: Date): Promise<void> {
    const fromDay = dateKey(parseLocalDate(occ.start));
    const toKey = dateKey(toDay);
    if (fromDay === toKey) return;
    const delta = Math.round((parseLocal(toKey).getTime() - parseLocal(fromDay).getTime()) / 86400000);
    const current = (await this.loadEvents()).find((e) => e.id === occ.event.id);
    if (!current) return;
    if (occ.event.recurrenceId) {
      await this.saveEventsList([{ ...occ.event, startsAt: shiftIsoDays(occ.event.startsAt, delta),
        endsAt: occ.event.endsAt ? shiftIsoDays(occ.event.endsAt, delta) : undefined }]);
      return;
    }
    if (current.repeats?.rule) {
      const pick = await askChoice(this.app, t("recurrence.choice"), [
        { label: t("recurrence.series"), value: "series" },
        { label: t("recurrence.single"), value: "single" },
      ]);
      if (!pick) return;
      if (pick === "series") {
        const newStart = shiftIsoDays(current.startsAt, delta);
        const shifted: CalendarEvent = {
          ...current,
          startsAt: newStart,
          endsAt: current.endsAt ? shiftIsoDays(current.endsAt, delta) : undefined,
          repeats: { rule: rebaseRuleOnMove(current.repeats.rule, parseLocal(newStart)) },
        };
        await this.saveEventsList([shifted]);
      } else {
        // 仅此实例:原实例 EXDATE 排除,目标日新建同内容单次日程
        const master: CalendarEvent = {
          ...current,
          skippedDates: [...new Set([...(current.skippedDates ?? []), fromDay])],
        };
        const override: CalendarEvent = {
          ...current,
          id: crypto.randomUUID() + "@myagenda",
          repeats: undefined,
          recurrenceOverrides: undefined,
          skippedDates: undefined,
          startsAt: shiftIsoDays(occ.start, delta),
          endsAt: occ.end ? shiftIsoDays(occ.end, delta) : undefined,
        };
        await this.saveEventsList([master, override]);
      }
      return;
    }
    const shifted: CalendarEvent = {
      ...current,
      startsAt: shiftIsoDays(current.startsAt, delta),
      endsAt: current.endsAt ? shiftIsoDays(current.endsAt, delta) : undefined,
    };
    await this.saveEventsList([shifted]);
  }

  /** 删除日程:本地块移除 + 账本条目移除,同步时传播到服务器。 */
  private async deleteEvent(ev: CalendarEvent): Promise<void> {
    if (ev.recurrenceId) {
      await this.saveEventsList([{ ...ev, status: "cancelled" }]);
      return;
    }
    await this.notes.removeByUids(new Set([ev.id]));
    // 账本保留条目并置为待删:下轮同步据此删除服务器副本(若直接移除条目,远端会被当成新增而复活)
    const entry = this.journal.events[ev.id];
    if (entry) entry.state = "pendingDelete";
    await this.saveJournal();
    this.invalidate();
    this.refreshPanels();
    void this.syncNow();
  }

  /** 停止同步某日历时,清空其在笔记中的现有日程(账本条目一并移除;iCloud 上保留)。 */
  async clearCalendarLocalEvents(cal: { id: string; name: string }): Promise<void> {
    const ids = new Set<string>();
    for (const [id, entry] of Object.entries(this.journal.events)) {
      if (entry.calendarId === cal.id) ids.add(id);
    }
    if (!ids.size) {
      new Notice(t("notice.clearNone"));
      return;
    }
    await this.notes.removeByUids(ids);
    for (const id of ids) journalRemove(this.journal, id);
    await this.saveJournal();
    this.invalidate();
    this.refreshPanels();
    new Notice(t("notice.clearDone", { n: ids.size }));
  }

  /** 重置全部同步数据:笔记中的日程事件、账本与同步令牌、账号与日历配置。iCloud 不受影响。 */
  async resetAllSyncData(): Promise<void> {
    const { events } = await this.notes.loadAll();
    const uids = new Set<string>(events.map((e) => e.id));
    for (const id of Object.keys(this.journal.events)) uids.add(id);
    if (uids.size) await this.notes.removeByUids(uids);
    this.journal = { version: 2, calendars: {}, events: {} }; // 深拷贝,避免共享 EMPTY_JOURNAL 内层引用
    await this.saveJournal();
    this.settings.user = "";
    this.settings.password = "";
    this.settings.calendars = [];
    this.settings.lastSync = undefined;
    await this.saveSettings();
    this.invalidate();
    this.refreshPanels();
    new Notice(t("notice.resetDone", { n: uids.size }));
  }

  /** 本地未同步日程数:状态非 synced,或推送指纹已置脏的账本条目。 */
  private pendingLocalCount(): number {
    let n = 0;
    for (const entry of Object.values(this.journal.events)) {
      if (entry.state !== "synced" || entry.pushedFingerprint === "dirty") n++;
    }
    return n;
  }




  async discover(): Promise<void> {
    try {
      if (!this.settings.user || !this.settings.password) {
        new Notice(t("notice.needCreds"), 10000);
        return;
      }
      const { calendars, root } = await discoverCalendars(obsidianHttp, {
        user: this.settings.user,
        pass: this.settings.password,
      });
      openDiscoverModal(this.app, calendars, new Set(this.settings.calendars.map((x) => x.url)), (picked) => {
        // Apple 日历颜色 → 写入对应分类的颜色表(渲染自动跟随 Apple 色)
        const appleColor = (cal: { url: string; color?: string }) => {
          if (!cal.color) return;
          const known = this.settings.calendars.find((x) => x.url === cal.url);
          if (known?.category) this.settings.categoryColors[known.category] = cal.color;
        };
        for (const dc of calendars) appleColor(dc);
        for (const c of picked) {
          if (this.settings.calendars.some((x) => x.url === c.url)) continue;
          this.settings.calendars.push({ id: c.id, url: c.url, name: c.name, category: c.name, enabled: true, color: c.color });
          if (c.color) this.settings.categoryColors[c.name] = c.color;
        }
        setCategoryColors(this.settings.categoryColors);
        void this.saveSettings().then(() => {
          new Notice(`[${root}] ` + t("notice.discoverDone", { n: picked.length }), 10000);
          this.refreshPanels();
        });
      });
    } catch (e) {
      new Notice(t("notice.discoverFail", { msg: e instanceof Error ? e.message : String(e) }), 10000);
    }
  }


  async exportIcs(): Promise<void> {
    try {
      const events = await this.loadEvents();
      if (events.length === 0) {
        new Notice(t("notice.exportEmpty"));
        return;
      }
      const path = `${this.settings.folder}/myagenda-export-${dateKey(new Date()).replace(/-/g, "")}.ics`;
      await this.io.writeText(path, buildIcs(events));
      new Notice(t("notice.exportDone", { n: events.length, path }), 10000);
    } catch (e) {
      new Notice(t("notice.exportError", { msg: e instanceof Error ? e.message : String(e) }), 10000);
    }
  }

  async migrateToClean(): Promise<void> {
    const months = new Set((await this.notes.listMonthPaths()).map((p) => p.slice(-10, -3)));
    let n = 0;
    const all = (await this.notes.loadAll()).events;
    const byMonth = new Map<string, typeof all>();
    for (const ev of all) {
      const m = monthOf(ev.startsAt);
      const list = byMonth.get(m) ?? [];
      list.push(ev);
      byMonth.set(m, list);
    }
    for (const month of months) {
      const preamble = await this.notes.readMonthPreamble(month);
      // 传库内全量(writeMonth 跨月清理按 id 全集判断)
      await this.notes.writeMonth(month, all, preamble);
      n++;
    }
    this.invalidate();
    new Notice(t("notice.migrateDone", { n }));
  }

  /** injectFolder 作用域:设置了前缀就只匹配其下(空 = 全库)。 */
  private inInjectScope(path: string): boolean {
    const folder = this.settings.injectFolder.trim().replace(/^\/|\/$/g, "");
    return folder === "" || path === folder || path.startsWith(folder + "/");
  }

  /** 同步成功后补充今日缺失条目，保留已有条目和勾选状态 */
  private async refreshTodayInjection(): Promise<void> {
    if (!this.settings.injectEnabled) return;
    const name = dateKey(new Date()) + ".md";
    const found = this.app.vault.getMarkdownFiles().find((f) => f.name === name && this.inInjectScope(f.path));
    if (!found) return;
    try {
      await this.injectIntoFile(found, false);
    } catch (e) {
      console.error("[myagenda-v2] injection refresh skipped", e);
    }
  }

  /** 启动兜底:日记在插件加载前已建(创建事件已错过)→ 主动补充缺失条目 */
  private async catchUpInjection(): Promise<void> {
    if (!this.settings.injectEnabled) return;
    const name = dateKey(new Date()) + ".md";
    const found = this.app.vault.getMarkdownFiles().find((f) => f.name === name && this.inInjectScope(f.path));
    if (!found) return;
    try {
      const content = await this.app.vault.cachedRead(found);
      if (!content.includes(this.settings.injectMarker)) return;
      await this.injectIntoFile(found, false);
    } catch (e) {
      console.error("[myagenda-v2] injection catch-up skipped", e);
    }
  }

  private pushSyncHistory(ok: boolean, msg: string): void {
    const entry = { at: new Date().toISOString(), ok, msg: msg || undefined };
    this.settings.syncHistory = [entry, ...this.settings.syncHistory].slice(0, 10);
  }

  /** 强制全量同步:丢弃增量游标,下轮扫描回退全量 REPORT。 */
  private async forceFullResync(): Promise<void> {
    for (const id of Object.keys(this.journal.calendars)) delete this.journal.calendars[id];
    await this.saveJournal();
    await this.syncNow();
  }

  private openSyncHistoryModal(): void {
    openSyncHistory(this.app, this.settings.syncHistory, () => void this.forceFullResync());
  }

  /** 清理 v1 残留:日记里的 agenda-injected 注入块 + 月度文件里的 v1 遗留字段行。 */
  async cleanupLegacy(): Promise<void> {
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f.name)) {
        await this.app.vault.process(f, (text) => {
          const [next, c] = stripLegacyFromDaily(text);
          n += c;
          return next;
        });
      } else if (f.path.startsWith(this.settings.folder + "/") && /\d{4}-\d{2}\.md$/.test(f.name)) {
        await this.app.vault.process(f, (text) => {
          const [next, c] = stripLegacyFromMonthly(text);
          n += c;
          return next;
        });
      }
    }
    this.invalidate();
    new Notice(n > 0 ? t("cleanup.done", { n }) : t("cleanup.none"));
  }

  async injectCommand(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice(t("inject.openFirst"));
      return;
    }
    const r = await this.injectIntoFile(file, true);
    if (r.status === "injected") new Notice(t("inject.done", { n: r.count ?? 0 }));
  }

  /** 只改变当前日记的注入记录，绝不取消、删除或完成云端日程。 */
  private injectionEditor(file: TFile): Editor | undefined {
    const active = this.app.workspace.getActiveViewOfType?.(MarkdownView);
    if (active?.file?.path === file.path && active.getMode() === "source") return active.editor;
    for (const leaf of this.app.workspace.getLeavesOfType?.("markdown") ?? []) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === "source") return view.editor;
    }
    return undefined;
  }

  private async changeInjectedTask(action: "skip" | "restore", selectedKey?: string, selectedFile?: TFile): Promise<void> {
    const file = selectedFile ?? this.app.workspace.getActiveFile();
    if (!file) { new Notice(t("inject.openFirst")); return; }
    const dm = file.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!dm) { new Notice(t("inject.notDiary")); return; }
    if (!this.inInjectScope(file.path)) { new Notice(t("inject.outsideFolder")); return; }
    try {
      const [y, mo, d] = dm[1].split("-").map(Number);
      const day = startOfDay(new Date(y, mo - 1, d));
      const items = action === "skip" ? buildInjectList(expandOccurrences(await this.loadEvents(), day, addDays(day, 1))) : [];
      const content = this.injectionEditor(file)?.getValue() ?? await this.app.vault.read(file);
      const tasks = action === "skip" ? listInjectedTasks(content, this.settings.injectMarker, items) : listSkippedTasks(content, this.settings.injectMarker);
      if (!tasks.length) { new Notice(t(action === "skip" ? "inject.noSkippable" : "inject.noSkipped")); return; }
      const key = selectedKey ?? await askChoice(this.app, t(action === "skip" ? "cmd.skipInjected" : "cmd.restoreInjected"),
        tasks.map((task) => ({ value: task.key, label: task.label })));
      if (key == null) return;
      let changed = false;
      const update = (current: string) => action === "skip" ? skipInjectedTask(current, this.settings.injectMarker, key, items) : restoreSkippedTask(current, this.settings.injectMarker, key);
      const editor = this.injectionEditor(file);
      if (editor) changed = updateEditorText(editor, update);
      else await this.app.vault.process(file, (current) => {
        const next = update(current); changed = next !== current; return next;
      });
      new Notice(t(changed ? action === "skip" ? "inject.skippedTask" : "inject.restoredTask" : "inject.taskChanged"));
    } catch (e) {
      console.error("[myagenda-v2] daily task update failed", e);
      new Notice(t("inject.updateFailed"));
    }
  }

  private async onFileCreate(file: TAbstractFile): Promise<void> {
    if (!this.settings.injectEnabled) return;
    if (!(file instanceof TFile) || file.extension !== "md" || !/^\d{4}-\d{2}-\d{2}\.md$/.test(file.name)) return;
    if (!this.inInjectScope(file.path)) return;
    let found = false;
    for (let attempt = 0; attempt < 6 && !found; attempt++) {
      await sleep(250 * (attempt + 1));
      try {
        const content = await this.app.vault.read(file);
        if (content.includes(this.settings.injectMarker)) found = true;
      } catch {
        return;
      }
    }
    if (!found) return;
    try {
      await this.injectIntoFile(file, false);
    } catch (e) {
      console.error("[myagenda-v2] injection skipped", e);
    }
  }

  private async injectIntoFile(file: TFile, force: boolean): Promise<{ status: string; count?: number; date?: string }> {
    const dm = file.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!dm) return { status: "not-diary", date: file.name };
    if (!this.inInjectScope(file.path)) return { status: "outside-folder", date: dm[1] };
    const date = dm[1];
    const [y, mo, d] = date.split("-").map(Number);
    const day = new Date(y, mo - 1, d);
    const events = await this.loadEvents();
    const occs: Occurrence[] = expandOccurrences(events, startOfDay(day), addDays(startOfDay(day), 1));
    const items = buildInjectList(occs);
    let status: string = "no-marker";
    let injectedCount: number | undefined;
    await this.app.vault.process(file, (content) => {
      const r = applyInjection(content, {
        marker: this.settings.injectMarker,
        items,
        force,
        preserveChecked: true,
        format: {
          checkbox: this.settings.injectUseCheckbox,
          place: this.settings.injectShowPlace,
          category: this.settings.injectShowCategory,
          prefix: this.settings.injectPrefix,
          timeFormat: this.settings.injectTimeFormat,
        },
      });
      status = r.status;
      injectedCount = r.count;
      return r.content;
    });
    return { status, count: injectedCount, date };
  }

  private reminderTimer: number | null = null;

  private startReminderPolling(): void {
    if (this.reminderTimer !== null) return;
    this.reminderTimer = window.setInterval(() => void this.checkReminders(), 60_000);
    void this.checkReminders();
  }

  /** 提醒:每分钟轮询,只发"刚到点"的(2 分钟回溯容忍),绝不提前、过点太久不补发。 */
  private async checkReminders(): Promise<void> {
    if (!this.settings.remindersEnabled) return;
    const events = await this.loadEvents();
    for (const due of dueReminders(events, new Date())) {
      const key = `${due.id}|${due.dueIso}`;
      if (this.firedReminders.has(key)) continue;
      if (this.firedReminders.size > 500) this.firedReminders.clear();
      this.firedReminders.add(key);
      new Notice(`⏰ ${due.title} · ${due.dueIso.slice(11, 16)}`, 10000);
    }
  }

  applyLanguage(): void {
    setLang(this.resolveLang());
    setCategoryColors(this.settings.categoryColors);
    this.refreshPanels();
  }

  refreshPanels(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
      (leaf.view as { rerender?: () => void }).rerender?.();
    }
  }

  restartAutoSync(): void {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = null;
    const minutes = this.settings.autoSyncMinutes;
    if (!minutes) return;
    this.autoSyncTimer = window.setInterval(() => {
      if (this.syncInFlight) return;
      void this.syncNow(false);
    }, minutes * 60_000);
  }
  private stopAutoSync(): void {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = null;
  }

  async saveSettings(): Promise<void> {
    if (this.settings.folder !== this.storageFolder) {
      if (this.syncInFlight) {
        this.settings.folder = this.storageFolder;
        new Notice("同步正在进行，请等待结束后再更改存储文件夹");
      } else {
        const previous = { folder: this.storageFolder, notes: this.notes, journal: this.journal };
        // 路径、笔记仓库和账本必须一起切换；期间阻止新同步启动。
        this.syncInFlight = true;
        try {
          this.storageFolder = this.settings.folder;
          this.notes = new MonthlyNoteStore(this.io, this.storageFolder);
          await this.loadJournal();
          this.invalidate();
          this.refreshPanels();
        } catch (error) {
          this.storageFolder = this.settings.folder = previous.folder;
          this.notes = previous.notes;
          this.journal = previous.journal;
          throw error;
        } finally {
          this.syncInFlight = false;
        }
      }
    }
    await this.saveData(this.settings);
  }
  async saveData(data: unknown): Promise<void> {
    // 交给 Obsidian 的 data.json 通道
    await super.saveData(data);
  }
  onunload(): void {
    this.stopAutoSync();
    if (this.touchRefreshTimer !== null) {
      window.clearTimeout(this.touchRefreshTimer);
      this.touchRefreshTimer = null;
    }
    if (this.reminderTimer !== null) {
      window.clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => window.setTimeout(r, ms));
}

const NETWORK_RE = /超时|timeout|ECONN|network|failed to fetch|fetch failed|ENOTFOUND|ERR_/i;

/** 网络类错误自动重试(1s/3s),其他错误直接抛出。 */
async function withNetworkRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const m = e instanceof Error ? e.message : String(e);
      if (attempt >= 2 || !NETWORK_RE.test(m)) throw e;
      await sleep([1000, 3000][attempt]);
    }
  }
  throw last;
}
