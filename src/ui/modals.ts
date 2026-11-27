import { App, Modal, Notice } from "obsidian";
import { t, getLang } from "../l10n/strings";
import type { CalendarEvent } from "../model/event";
import type { DiscoveredCalendar } from "../sync/dav";
import { categoryColor } from "./palette";
import { toLocalIso } from "../kernel/dates";

/** 冲突裁决弹窗。 */
export function askConflict(
  app: App,
  info: { title: string; mine: string; theirs: string },
): Promise<"mine" | "theirs" | null> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: "mine" | "theirs" | null) => {
      if (done) return;
      done = true;
      resolve(v);
      modal.close();
    };
    const modal = new Modal(app);
    modal.modalEl.addClass("ag2-modal");
    modal.contentEl.createDiv({ cls: "ag2-conflict-title", text: t("conflict.title") });
    modal.contentEl.createDiv({ cls: "ag2-conflict-name", text: info.title });
    const rows = modal.contentEl.createDiv({ cls: "ag2-conflict-rows ag2-conflict-cols" });
    const row = (label: string, meta: string, pick: "mine" | "theirs", tint: string) => {
      const btn = rows.createEl("button", { cls: "ag2-conflict-row" });
      btn.style.setProperty("--col-c", tint);
      btn.createDiv({ cls: "ag2-conflict-label", text: label });
      btn.createDiv({ cls: "ag2-conflict-meta", text: meta });
      btn.addEventListener("click", () => settle(pick));
      return btn;
    };
    const mine = row(t("conflict.mine"), info.mine, "mine", "var(--ag-tint)");
    row(t("conflict.theirs"), info.theirs, "theirs", "var(--text-faint)");
    modal.onClose = () => settle(null);
    modal.open();
    mine.focus();
  });
}

export interface EditResult {
  ev: CalendarEvent;
  deleted: boolean;
}

/** 事件编辑弹窗:新增与编辑共用;删除返回 deleted=true。 */
function addMinutesHHMM(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60) % 24;
  return `${String(hh).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function presetCategories(): string[] {
  return getLang() === "zh"
    ? ["工作", "个人", "上学", "旅行", "健康", "其他"]
    : ["Work", "Personal", "School", "Travel", "Health", "Other"];
}

export interface EditorDefaults {
  defaultCategory?: string;
  defaultReminderMinutes?: number;
  /** 可选的分类胶囊来源(启用日历的分类);缺省时用内置预设。 */
  categories?: string[];
}

const REPEAT_PRESETS: { key: string; labelKey: "repeat.none" | "repeat.daily" | "repeat.weekly" | "repeat.biweekly" | "repeat.monthly" | "repeat.yearly"; rule: (start: Date) => string }[] = [
  { key: "none", labelKey: "repeat.none", rule: () => "" },
  { key: "daily", labelKey: "repeat.daily", rule: () => "FREQ=DAILY" },
  { key: "weekly", labelKey: "repeat.weekly", rule: (d) => `FREQ=WEEKLY;BYDAY=${["SU","MO","TU","WE","TH","FR","SA"][d.getDay()]}` },
  { key: "biweekly", labelKey: "repeat.biweekly", rule: (d) => `FREQ=WEEKLY;INTERVAL=2;BYDAY=${["SU","MO","TU","WE","TH","FR","SA"][d.getDay()]}` },
  { key: "monthly", labelKey: "repeat.monthly", rule: () => `FREQ=MONTHLY` },
  { key: "yearly", labelKey: "repeat.yearly", rule: () => `FREQ=YEARLY` },
];

/** 同步历史:最近 10 次结果 + 强制全量同步入口。 */
export function openSyncHistory(
  app: App,
  history: { at: string; ok: boolean; msg?: string }[],
  onForceFull: () => void,
): void {
  const modal = new Modal(app);
  modal.modalEl.addClass("ag2-modal");
  const content = modal.contentEl;
  content.createDiv({ cls: "ag2-conflict-title", text: t("sync.history.title") });
  const list = content.createDiv({ cls: "ag2-sync-hist" });
  if (history.length === 0) list.createDiv({ cls: "ag2-empty", text: t("sync.history.empty") });
  for (const h of history) {
    const row = list.createDiv({ cls: "ag2-sync-hist-row" });
    const d = new Date(h.at);
    const p2 = (x: number): string => String(x).padStart(2, "0");
    const time = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    row.createDiv({ cls: "ag2-sync-hist-status" + (h.ok ? " ok" : " bad"), text: h.ok ? "✓" : "✗" });
    const main = row.createDiv({ cls: "ag2-sync-hist-main" });
    main.createDiv({ cls: "ag2-sync-hist-time", text: time });
    if (h.msg) main.createDiv({ cls: "ag2-sync-hist-msg", text: h.msg });
  }
  const btn = content.createEl("button", { cls: "ag2-btn ag2-btn-cancel", text: t("sync.history.force") });
  btn.addEventListener("click", () => {
    modal.close();
    onForceFull();
  });
  modal.open();
}

/** 日历发现:勾选要导入的日历(已在库中的禁用并标注)。 */
export function openDiscoverModal(
  app: App,
  calendars: DiscoveredCalendar[],
  existingUrls: Set<string>,
  onPick: (picked: DiscoveredCalendar[]) => void,
): void {
  const modal = new Modal(app);
  modal.modalEl.addClass("ag2-modal");
  const content = modal.contentEl;
  content.createDiv({ cls: "ag2-conflict-title", text: t("discover.title") });
  const list = content.createDiv({ cls: "ag2-discover-list" });
  const picked = new Set<string>(calendars.filter((c) => !existingUrls.has(c.url)).map((c) => c.id));
  for (const c of calendars) {
    const exists = existingUrls.has(c.url);
    const row = list.createDiv({ cls: "ag2-discover-row" });
    const cb = row.createEl("input", { type: "checkbox" });
    cb.checked = picked.has(c.id);
    cb.disabled = exists;
    if (exists) row.addClass("is-existing");
    const nameCell = row.createDiv({ cls: "ag2-discover-name", text: c.name || c.id.slice(0, 8) });
    if (c.color) {
      const dot = nameCell.createSpan({ cls: "ag2-discover-dot" });
      dot.setCssStyles({ background: c.color });
    }
    cb.addEventListener("change", () => {
      if (cb.checked) picked.add(c.id);
      else picked.delete(c.id);
    });
  }
  const footer = content.createDiv({ cls: "ag2-editor-footer" });
  const ok = footer.createEl("button", { cls: "ag2-btn ag2-btn-primary", text: t("discover.import", { n: picked.size }) });
  ok.addEventListener("click", () => {
    modal.close();
    onPick(calendars.filter((c) => picked.has(c.id)));
  });
  footer.createEl("button", { cls: "ag2-btn ag2-btn-cancel", text: t("editor.cancel") }).addEventListener("click", () => modal.close());
  modal.open();
}

export function openEventEditor(
  app: App,
  existing: CalendarEvent | null,
  defaultDate: string,
  onSave: (ev: CalendarEvent) => void | Promise<void>,
  onDelete?: (ev: CalendarEvent) => void | Promise<void>,
  defaults: EditorDefaults = {},
  defaultStartHHMM?: string,
  defaultEndHHMM?: string,
): void {
  const modal = new Modal(app);
  modal.modalEl.addClass("ag2-modal", "ag2-event-editor");
  modal.setTitle(t(existing ? "editor.titleEdit" : "editor.titleNew"));
  const content = modal.contentEl;
  const ev: CalendarEvent = existing ?? {
    id: crypto.randomUUID() + "@myagenda",
    title: "",
    startsAt: `${defaultDate}T${defaultStartHHMM ?? "09:00"}:00`,
    endsAt: `${defaultDate}T${defaultEndHHMM ?? addMinutesHHMM(defaultStartHHMM ?? "09:00", 60)}:00`,
    isAllDay: false,
    category: defaults.defaultCategory || undefined,
    reminderMinutes:
      defaults.defaultReminderMinutes !== undefined && defaults.defaultReminderMinutes >= 0
        ? [defaults.defaultReminderMinutes]
        : undefined,
  };

  // 大标题输入(Apple 式:无边框、加粗、置顶)
  const titleInput = content.createEl("input", { cls: "ag2-f-title", placeholder: t("editor.field.title") });
  titleInput.setAttr("aria-label", t("editor.field.title"));
  titleInput.value = ev.title;

  const addRow = (card: HTMLElement, label: string): HTMLElement => {
    const r = card.createDiv({ cls: "ag2-row" });
    r.createDiv({ cls: "ag2-row-label", text: label });
    return r.createDiv({ cls: "ag2-row-ctrl" });
  };

  // 卡片一:时间
  const cardTime = content.createDiv({ cls: "ag2-card ag2-editor-time" });
  const rowsTime = cardTime.createDiv({ cls: "ag2-card-rows" });

  const alldayCtrl = addRow(rowsTime, t("editor.field.allday"));
  const allday = alldayCtrl.createEl("input", { type: "checkbox", cls: "ag2-switch" });
  allday.setAttr("aria-label", t("editor.field.allday"));
  allday.checked = ev.isAllDay;

  const startCtrl = addRow(rowsTime, t("editor.field.start"));
  const startInput = startCtrl.createEl("input", { type: ev.isAllDay ? "date" : "datetime-local", cls: "ag2-f-dt" });
  startInput.setAttr("aria-label", t("editor.field.start"));
  startInput.value = ev.isAllDay ? ev.startsAt.slice(0, 10) : ev.startsAt.slice(0, 16);

  const endCtrl = addRow(rowsTime, t("editor.field.end"));
  const endInput = endCtrl.createEl("input", { type: ev.isAllDay ? "date" : "datetime-local", cls: "ag2-f-dt" });
  endInput.setAttr("aria-label", t("editor.field.end"));
  endInput.value = ev.endsAt ? (ev.isAllDay ? ev.endsAt.slice(0, 10) : ev.endsAt.slice(0, 16)) : "";

  let startClock = startInput.value.slice(11) || defaultStartHHMM || "09:00";
  let endClock = endInput.value.slice(11) || defaultEndHHMM || addMinutesHHMM(startClock, 60);
  const syncTypes = () => {
    const start = startInput.value;
    const end = endInput.value;
    if (allday.checked) {
      startClock = start.slice(11) || startClock;
      endClock = end.slice(11) || endClock;
    }
    const type = allday.checked ? "date" : "datetime-local";
    startInput.type = type;
    endInput.type = type;
    startInput.value = allday.checked || !start ? start.slice(0, 10) : start + "T" + startClock;
    endInput.value = allday.checked || !end ? end.slice(0, 10) : end + "T" + endClock;
  };
  allday.addEventListener("change", syncTypes);
  // Apple 行为:改动开始时间后,结束时间空着或早于开始时自动顺延一小时
  startInput.addEventListener("change", () => {
    if (endInput.value) return;
    const base = new Date(startInput.value);
    if (Number.isNaN(base.getTime())) return;
    base.setHours(base.getHours() + 1);
    const p2 = (n: number) => String(n).padStart(2, "0");
    endInput.value = allday.checked
      ? `${base.getFullYear()}-${p2(base.getMonth() + 1)}-${p2(base.getDate())}`
      : `${base.getFullYear()}-${p2(base.getMonth() + 1)}-${p2(base.getDate())}T${p2(base.getHours())}:${p2(base.getMinutes())}`;
  });

  const details = content.createDiv({ cls: "ag2-card ag2-card-rows ag2-editor-details" });
  const repeatCtrl = addRow(details, t("editor.field.repeat"));
  const repeatSel = repeatCtrl.createEl("select", { cls: "ag2-f-sel" });
  repeatSel.setAttr("aria-label", t("editor.field.repeat"));
  const startDate = new Date(ev.startsAt);
  for (const p of REPEAT_PRESETS) repeatSel.createEl("option", { value: p.key, text: t(p.labelKey) });
  repeatSel.createEl("option", { value: "custom", text: t("editor.repeat.custom") });
  const presetOf = (rule?: string): string => {
    if (!rule) return "none";
    const hit = REPEAT_PRESETS.find((x) => x.rule(startDate).toUpperCase() === rule.toUpperCase());
    return hit ? hit.key : "custom";
  };
  repeatSel.value = presetOf(ev.repeats?.rule);
  const repeatInput = repeatCtrl.createEl("input", { cls: "ag2-f-dt", placeholder: "FREQ=WEEKLY" });
  repeatInput.setAttr("aria-label", t("editor.repeat.custom"));
  repeatInput.value = ev.repeats?.rule ?? "";
  repeatInput.style.display = repeatSel.value === "custom" ? "" : "none";
  repeatSel.addEventListener("change", () => {
    repeatInput.style.display = repeatSel.value === "custom" ? "" : "none";
    if (repeatSel.value !== "custom") {
      const p = REPEAT_PRESETS.find((x) => x.key === repeatSel.value);
      repeatInput.value = p ? p.rule(startDate) : "";
    }
  });

  const statusCtrl = addRow(details, t("editor.field.status"));
  const statusSel = statusCtrl.createEl("select", { cls: "ag2-f-sel" });
  statusSel.setAttr("aria-label", t("editor.field.status"));
  for (const [v, labelKey] of [
    ["", "status.confirmed"],
    ["tentative", "status.tentative"],
    ["cancelled", "status.cancelled"],
  ] as const) {
    statusSel.createEl("option", { value: v, text: t(labelKey) });
  }
  statusSel.value = ev.status ?? "";

  const remindCtrl = addRow(details, t("editor.field.reminder"));
  const remindInput = remindCtrl.createEl("input", { cls: "ag2-f-dt" });
  remindInput.setAttr("aria-label", t("editor.field.reminder"));
  remindCtrl.addClass("ag2-editor-reminder");
  const hint = remindCtrl.createDiv({ cls: "ag2-editor-hint", text: t("editor.reminderHint") });
  hint.id = "ag2-reminder-" + crypto.randomUUID();
  remindInput.setAttr("aria-describedby", hint.id);
  remindInput.value = (ev.reminderMinutes ?? []).join(", ");

  // 卡片二:分类(预设胶囊单选)
  const catRow = addRow(details, t("editor.field.category"));
  const catChips = catRow.createDiv({ cls: "ag2-chips" });
  let catValue = ev.category ?? "";
  const renderChips = (): void => {
    catChips.empty();
    for (const c of defaults.categories?.length ? defaults.categories : presetCategories()) {
      const chip = catChips.createEl("button", { cls: "ag2-chipbtn" + (catValue === c ? " is-on" : ""), text: c });
      chip.style.setProperty("--category-color", categoryColor(c));
      chip.setAttr("aria-pressed", String(catValue === c));
      chip.addEventListener("click", () => {
        catValue = catValue === c ? "" : c;
        renderChips();
      });
    }
  };
  renderChips();

  // 卡片三:地点
  const placeCtrl = addRow(details, t("editor.field.place"));
  const placeInput = placeCtrl.createEl("input", { cls: "ag2-f-dt ag2-f-wide" });
  placeInput.setAttr("aria-label", t("editor.field.place"));
  placeInput.value = ev.place ?? "";

  // 卡片四:备注
  const noteCtrl = addRow(details, t("editor.field.notes"));
  // 备注用 contenteditable 纯文本块:高度天然随内容,不受主题对 textarea 的高度规则影响
  const notesInput = noteCtrl.createDiv({ cls: "ag2-f-note ag2-f-note-ed" });
  notesInput.setAttr("contenteditable", "plaintext-only");
  notesInput.setAttr("role", "textbox");
  notesInput.setAttr("aria-label", t("editor.field.notes"));
  notesInput.setAttr("aria-multiline", "true");
  notesInput.setText(ev.notes ?? "");
  notesInput.toggleClass("is-empty", !(ev.notes ?? "").trim());
  notesInput.addEventListener("input", () => {
    notesInput.toggleClass("is-empty", !(notesInput.textContent || "").trim());
  });
  // plaintext-only 的回车换行显式处理,保证 textContent 保留 

  notesInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      window.document.execCommand("insertLineBreak");
    }
  });

  const readBack = (): CalendarEvent => {
    const s = allday.checked
      ? startInput.value
      : startInput.value
        ? toLocalIso(new Date(startInput.value))
        : ev.startsAt;
    const e2 = allday.checked ? endInput.value : endInput.value ? toLocalIso(new Date(endInput.value)) : "";
    return {
      ...ev,
      title: titleInput.value.trim() || "—",
      startsAt: s,
      endsAt: e2 || undefined,
      isAllDay: allday.checked,
      category: catValue || undefined,
      place: placeInput.value.trim() || undefined,
      notes: (notesInput.innerText || "").trim() || undefined,
      reminderMinutes: remindInput.value
        ? remindInput.value.split(",").map((x) => Number.parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n))
        : undefined,
      repeats: repeatInput.value.trim() ? { rule: repeatInput.value.trim().toUpperCase() } : undefined,
      status: statusSel.value || undefined,
    };
  };

  const footer = content.createDiv({ cls: "ag2-editor-footer" });
  footer.createEl("button", { cls: "ag2-btn ag2-btn-ghost", text: t("editor.cancel") }).addEventListener("click", () => modal.close());
  if (existing && onDelete) {
    footer
      .createEl("button", { cls: "ag2-btn ag2-btn-ghost ag2-danger", text: t("editor.delete") })
      .addEventListener("click", () => {
        void (async () => {
          // 删除会同步到服务器,必须显式确认(原 Notice 提示形同虚设)
          const ok = await askChoice(app, t("editor.confirmDelete"), [
            { value: "yes", label: t("editor.delete") },
          ]);
          if (ok !== "yes") return;
          await onDelete(existing);
          modal.close();
        })();
      });
  }
  footer.createEl("button", { cls: "ag2-btn ag2-btn-primary", text: t("editor.save") }).addEventListener("click", () => {
    void (async () => {
      await onSave(readBack());
      modal.close();
    })();
  });
  modal.open();
  titleInput.focus();
}

export function askChoice(app: App, title: string, options: { label: string; value: string }[]): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
      modal.close();
    };
    const modal = new Modal(app);
    modal.modalEl.addClass("ag2-modal");
    modal.contentEl.createDiv({ cls: "ag2-conflict-title", text: title });
    const rows = modal.contentEl.createDiv({ cls: "ag2-conflict-rows" });
    for (const opt of options) {
      const btn = rows.createEl("button", { cls: "ag2-conflict-row ag2-choice", text: opt.label });
      btn.addEventListener("click", () => settle(opt.value));
    }
    modal.onClose = () => settle(null);
    modal.open();
  });
}
