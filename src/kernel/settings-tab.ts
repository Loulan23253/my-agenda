import { requireApiVersion, App, PluginSettingTab, Setting, type SettingDefinitionItem, type SettingDefinitionGroup, type SettingGroupItem } from "obsidian";
import { askChoice } from "../ui/modals";
import { setCategoryColors } from "../ui/palette";
import { t } from "../l10n/strings";
import type MyAgendaPluginV2 from "../main";
import type { Settings } from "./settings";

/** 设置页:同步 / 日历 / 外观 / 日记注入。 */
export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MyAgendaPluginV2) {
    super(app, plugin);
  }

  display(): void {
    this.renderLegacySettings();
  }

  private renderLegacySettings(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    // 版本标识:一眼确认 Obsidian 里跑的是哪个构建(排查"改了没生效")
    containerEl.createDiv({ cls: "ag2-version-stamp", text: `MyAgenda · v${this.plugin.manifest.version}` });

    new Setting(containerEl).setName(t("settings.section.sync")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.lang"))
      .addDropdown((d) => {
        d.addOption("auto", "Auto");
        d.addOption("zh", "简体中文");
        d.addOption("en", "English");
        d.setValue(s.lang);
        d.onChange(async (v) => {
          s.lang = v as Settings["lang"];
          await this.plugin.saveSettings();
          this.plugin.applyLanguage();
          this.renderLegacySettings();
        });
      });

    new Setting(containerEl)
      .setName(t("settings.provider"))
      .addDropdown((d) => {
        d.addOption("none", t("settings.provider.none"));
        d.addOption("icloud", t("settings.provider.icloud"));
        d.addOption("caldav", t("settings.provider.caldav"));
        d.addOption("ics", t("settings.provider.ics"));
        d.setValue(s.provider);
        d.onChange(async (v) => {
          s.provider = v as Settings["provider"];
          await this.plugin.saveSettings();
          this.renderLegacySettings();
        });
      });

    new Setting(containerEl).setName(t("settings.user")).addText((x) =>
      x.setValue(s.user).onChange(async (v) => {
        s.user = v.trim();
        await this.plugin.saveSettings();
      }),
    );

    const pw = new Setting(containerEl).setName(t("settings.password"));
    let pwVisible = false;
    let pwText: import("obsidian").TextComponent | undefined;
    const pwToggle = (btn: import("obsidian").ExtraButtonComponent) => {
      btn.setIcon(pwVisible ? "eye-off" : "eye").setTooltip(pwVisible ? t("settings.password.hide") : t("settings.password.show"));
    };
    pw.addText((x) => {
      x.inputEl.type = "password";
      x.setValue(s.password).onChange(async (v) => {
        s.password = v.trim();
        await this.plugin.saveSettings();
      });
      pwText = x;
    });
    pw.addExtraButton((b) => {
      pwToggle(b);
      b.onClick(() => {
        pwVisible = !pwVisible;
        if (pwText) pwText.inputEl.type = pwVisible ? "text" : "password";
        pwToggle(b);
      });
    });

    if (s.provider === "icloud") {
      new Setting(containerEl)
        .setName(t("settings.calendars"))
        .addExtraButton((b) =>
          b.setIcon("search").setTooltip(t("settings.fetchCalendars")).onClick(() => void this.plugin.discover()),
        );
      for (const cal of s.calendars) {
        const row = new Setting(containerEl).setName(cal.name || cal.url).setDesc(cal.url);
        row.addText((x: import("obsidian").TextComponent) =>
          x.setPlaceholder(t("settings.categoryPlaceholder")).setValue(cal.category).onChange(async (v) => {
            cal.category = v.trim();
            await this.plugin.saveSettings();
          }),
        );
        row.addToggle((tg) =>
          tg.setValue(cal.enabled).onChange(async (v) => {
            if (v) {
              cal.enabled = true;
              await this.plugin.saveSettings();
              this.renderLegacySettings();
              return;
            }
            // 关闭同步:询问是否同时清空该日历在笔记中的现有日程(iCloud 上保留)
            const choice = await askChoice(
              this.app,
              t("settings.cal.disable.title", { name: cal.name || cal.id }),
              [
                { value: "keep", label: t("settings.cal.disable.keep") },
                { value: "clear", label: t("settings.cal.disable.clear") },
              ],
            );
            if (choice === null) {
              this.renderLegacySettings(); // 取消:回滚开关
              return;
            }
            cal.enabled = false;
            await this.plugin.saveSettings();
            if (choice === "clear") await this.plugin.clearCalendarLocalEvents(cal);
            this.renderLegacySettings();
          }),
        );
        row.addExtraButton((b) =>
          b.setIcon("trash").onClick(async () => {
            s.calendars = s.calendars.filter((x) => x !== cal);
            await this.plugin.saveSettings();
            this.renderLegacySettings();
          }),
        );
      }
    }

    if (s.provider === "ics") {
      new Setting(containerEl).setName(t("settings.calUrl")).addText((x) =>
        x.setValue(s.icsUrl).onChange(async (v) => {
          s.icsUrl = v.trim();
          await this.plugin.saveSettings();
        }),
      );
    }

    new Setting(containerEl)
      .setName(t("settings.autoSync"))
      .addDropdown((d) => {
        for (const v of [0, 5, 15, 30, 60]) {
          d.addOption(String(v), v === 0 ? t("settings.autoSync.off") : `${v} min`);
        }
        d.setValue(String(s.autoSyncMinutes));
        d.onChange(async (v) => {
          s.autoSyncMinutes = Number(v);
          await this.plugin.saveSettings();
          this.plugin.restartAutoSync();
        });
      });

    this.renderMonthActivity(new Setting(containerEl));

    new Setting(containerEl)
      .setName(t("settings.conflictPolicy"))
      .addDropdown((d) => {
        d.addOption("ask", t("settings.conflictPolicy.ask"));
        d.addOption("server", t("settings.conflictPolicy.server"));
        d.setValue(s.conflictPolicy);
        d.onChange(async (v) => {
          s.conflictPolicy = v as Settings["conflictPolicy"];
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setClass("ag2-reset-setting")
      .setName(t("settings.reset.name"))
      .setDesc(t("settings.reset.desc"))
      .addButton((b) =>
        b.setButtonText(t("settings.reset.button")).onClick(async () => {
          const c = await askChoice(this.app, t("settings.reset.confirm"), [
            { value: "reset", label: t("settings.reset.confirmYes") },
          ]);
          if (c !== "reset") return;
          await this.plugin.resetAllSyncData();
          this.renderLegacySettings();
        }),
      );

    new Setting(containerEl).setName(t("settings.section.appearance")).setHeading();
    {
      const cats = new Set<string>((s.calendars ?? []).filter((c) => c.enabled && c.category.trim()).map((c) => c.category.trim()));
      if (s.defaultCategory.trim()) cats.add(s.defaultCategory.trim());
      for (const [cat, color] of Object.entries(s.categoryColors)) if (color) cats.add(cat);
      for (const cat of [...cats].sort()) {
        new Setting(containerEl)
          .setName(cat)
          .addText((x) => {
            x.setValue(s.categoryColors[cat] ?? "");
            x.inputEl.type = "color";
            x.inputEl.addClass("ag2-colorinput");
            x.onChange(async (v) => {
              if (/^#[0-9a-fA-F]{6}$/.test(v)) { s.categoryColors[cat] = v; } else { delete s.categoryColors[cat]; }
              setCategoryColors(s.categoryColors);
              await this.plugin.saveSettings();
            });
          });
      }
    }
    new Setting(containerEl)
      .setName(t("settings.accent"))
      .addDropdown((d) => {
        d.addOption("ios", t("settings.accent.ios"));
        d.addOption("theme", t("settings.accent.theme"));
        d.addOption("custom", t("settings.accent.custom"));
        d.setValue(["ios", "theme"].includes(s.accent) ? s.accent : "custom");
        d.onChange(async (v) => {
          s.accent = v === "custom" ? "#007aff" : v;
          await this.plugin.saveSettings();
          this.plugin.refreshPanels();
        });
      });
    new Setting(containerEl)
      .setName(t("settings.weekStart"))
      .addDropdown((d) => {
        d.addOption("1", t("settings.weekStart.mon"));
        d.addOption("0", t("settings.weekStart.sun"));
        d.setValue(String(s.weekStart));
        d.onChange(async (v) => {
          s.weekStart = v === "0" ? 0 : 1;
          await this.plugin.saveSettings();
          this.plugin.refreshPanels();
        });
      });

    new Setting(containerEl).setName(t("settings.section.inject")).setHeading();
    new Setting(containerEl)
      .setName(t("cmd.inject"))
      .setDesc(t("inject.openFirst"))
      .addButton((b) => b.setButtonText(t("cmd.inject")).onClick(() => void this.plugin.injectCommand()));
    new Setting(containerEl).setName(t("settings.inject.enable")).addToggle((tg) =>
      tg.setValue(s.injectEnabled).onChange(async (v) => {
        s.injectEnabled = v;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName(t("settings.inject.marker")).addText((x) =>
      x.setValue(s.injectMarker).onChange(async (v) => {
        s.injectMarker = v;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName(t("settings.inject.folder")).addText((x) =>
      x.setValue(s.injectFolder).onChange(async (v) => {
        s.injectFolder = v.trim();
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl).setName(t("settings.inject.useCheckbox")).setDesc(t("settings.inject.useCheckbox.desc")).addToggle((tg) =>
      tg.setValue(s.injectUseCheckbox).onChange(async (v) => {
        s.injectUseCheckbox = v;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName(t("settings.inject.showPlace")).setDesc(t("settings.inject.showPlace.desc")).addToggle((tg) =>
      tg.setValue(s.injectShowPlace).onChange(async (v) => {
        s.injectShowPlace = v;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName(t("settings.inject.showCategory")).setDesc(t("settings.inject.showCategory.desc")).addToggle((tg) =>
      tg.setValue(s.injectShowCategory).onChange(async (v) => {
        s.injectShowCategory = v;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName(t("settings.inject.prefix")).addDropdown((d) => {
      d.addOption(">>", t("settings.inject.prefix.nested"));
      d.addOption(">", t("settings.inject.prefix.plain"));
      d.setValue(s.injectPrefix);
      d.onChange(async (v) => {
        s.injectPrefix = v === ">" ? ">" : ">>";
        await this.plugin.saveSettings();
      });
    });
    new Setting(containerEl).setName(t("settings.inject.timeFormat")).addDropdown((d) => {
      d.addOption("24h", t("settings.inject.timeFormat.24h"));
      d.addOption("12h", t("settings.inject.timeFormat.12h"));
      d.setValue(s.injectTimeFormat);
      d.onChange(async (v) => {
        s.injectTimeFormat = v === "12h" ? "12h" : "24h";
        await this.plugin.saveSettings();
      });
    });

    new Setting(containerEl).setName(t("settings.reminders")).addToggle((tg) =>
      tg.setValue(s.remindersEnabled).onChange(async (v) => {
        s.remindersEnabled = v;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl).setName(t("settings.folderName")).addText((x) =>
      x.setValue(s.folder).onChange(async (v) => {
        s.folder = v.trim() || "Agenda";
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl).setName(t("settings.section.defaults")).setHeading();
    new Setting(containerEl).setName(t("settings.defaultCategory")).addText((x) =>
      x.setValue(s.defaultCategory).onChange(async (v) => {
        s.defaultCategory = v.trim();
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName(t("settings.defaultReminder")).addText((x) =>
      x.setValue(String(s.defaultReminderMinutes)).onChange(async (v) => {
        const n = Number.parseInt(v, 10);
        s.defaultReminderMinutes = Number.isFinite(n) ? n : -1;
        await this.plugin.saveSettings();
      }),
    );



    new Setting(containerEl).setName(t("settings.security.note.name")).setDesc(t("settings.security.note.desc"));

    new Setting(containerEl).setName(t("settings.debug.name")).addToggle((tg) =>
      tg.setValue(s.debugLogging).onChange(async (v) => {
        s.debugLogging = v;
        await this.plugin.saveSettings();
      }),
    );

    // 赞助入口:manifest 提供 fundingUrl 时才显示
    const funding = String((this.plugin.manifest as unknown as { fundingUrl?: string }).fundingUrl || "");
    if (funding) {
      new Setting(containerEl).setName(t("support.name")).setDesc(t("support.desc"))
        .addButton((b) => b.setButtonText(t("support.button")).setCta().onClick(() => window.open(funding)));
    }
  }

  // —— 1.13+ 声明式设置:注册进设置搜索;1.12 及以下仍走 display()。 ——

  private renderMonthActivity(setting: Setting): void {
    setting.setName(t("months.title")).addButton(b =>
      b.setButtonText(t("months.open")).onClick(() => this.plugin.openMonthActivity())
    );
  }

  private groupOf(heading: string, items: SettingGroupItem[]): SettingDefinitionGroup {
    return { type: "group", heading, items };
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.groupOf(t("settings.section.sync"), [
        { name: t("settings.lang"), control: { type: "dropdown", key: "lang", options: { auto: "Auto", zh: "简体中文", en: "English" } } },
        { name: t("settings.provider"), control: { type: "dropdown", key: "provider", options: { none: t("settings.provider.none"), icloud: t("settings.provider.icloud"), caldav: t("settings.provider.caldav"), ics: t("settings.provider.ics") } } },
        { name: t("settings.user"), control: { type: "text", key: "user" } },
        {
          name: t("settings.password"),
          searchable: false,
          render: (setting: Setting) => {
            setting.setName(t("settings.password"));
            let visible = false;
            let pwText: import("obsidian").TextComponent | undefined;
            setting.addText((x) => {
              x.inputEl.type = "password";
              x.setValue(this.plugin.settings.password).onChange(async (v) => {
                this.plugin.settings.password = v.trim();
                await this.plugin.saveSettings();
              });
              pwText = x;
            });
            setting.addExtraButton((b) => {
              const paint = () => {
                b.setIcon(visible ? "eye-off" : "eye").setTooltip(visible ? t("settings.password.hide") : t("settings.password.show"));
              };
              paint();
              b.onClick(() => {
                visible = !visible;
                if (pwText) pwText.inputEl.type = visible ? "text" : "password";
                paint();
              });
            });
          },
        },
        {
          name: t("settings.calendars"),
          searchable: false,
          visible: () => this.plugin.settings.provider === "icloud",
          render: (setting: Setting) => {
            setting.setName(t("settings.calendars")).setDesc(this.plugin.settings.calendars.map((c) => `${c.enabled ? "☑" : "☐"} ${c.name || c.url}`).join("  ") || t("settings.calUrl"));
            setting.addExtraButton((b) => b.setIcon("search").setTooltip(t("settings.fetchCalendars")).onClick(() => void this.plugin.discover()));
          },
        },
        {
          name: t("settings.calUrl"),
          searchable: false,
          visible: () => this.plugin.settings.provider === "ics",
          control: { type: "text", key: "icsUrl" },
        },
        { name: t("settings.autoSync"), control: { type: "dropdown", key: "autoSyncMinutes", options: Object.fromEntries([0, 5, 15, 30, 60].map((v) => [String(v), v === 0 ? t("settings.autoSync.off") : `${v} min`])) } },
        { name: t("months.title"), render: (setting: Setting) => this.renderMonthActivity(setting) },
        { name: t("settings.conflictPolicy"), control: { type: "dropdown", key: "conflictPolicy", options: { ask: t("settings.conflictPolicy.ask"), server: t("settings.conflictPolicy.server") } } },
      ]),
      this.groupOf(t("settings.section.appearance"), [
        { name: t("settings.accent"), control: { type: "dropdown", key: "accent", options: { ios: t("settings.accent.ios"), theme: t("settings.accent.theme"), custom: t("settings.accent.custom") } } },
        { name: t("settings.weekStart"), control: { type: "dropdown", key: "weekStart", options: { "1": t("settings.weekStart.mon"), "0": t("settings.weekStart.sun") } } },
      ]),
      this.groupOf(t("settings.section.inject"), [
        {
          name: t("cmd.inject"),
          desc: t("inject.openFirst"),
          searchable: false,
          render: (setting: Setting) => {
            setting.setName(t("cmd.inject")).setDesc(t("inject.openFirst"));
            setting.addButton((b) => b.setButtonText(t("cmd.inject")).onClick(() => void this.plugin.injectCommand()));
          },
        },
        { name: t("settings.inject.enable"), control: { type: "toggle", key: "injectEnabled" } },
        { name: t("settings.inject.marker"), control: { type: "text", key: "injectMarker" } },
        { name: t("settings.inject.folder"), control: { type: "text", key: "injectFolder" } },
        { name: t("settings.inject.useCheckbox"), desc: t("settings.inject.useCheckbox.desc"), control: { type: "toggle", key: "injectUseCheckbox" } },
        { name: t("settings.inject.showPlace"), desc: t("settings.inject.showPlace.desc"), control: { type: "toggle", key: "injectShowPlace" } },
        { name: t("settings.inject.showCategory"), desc: t("settings.inject.showCategory.desc"), control: { type: "toggle", key: "injectShowCategory" } },
        { name: t("settings.inject.prefix"), control: { type: "dropdown", key: "injectPrefix", options: { ">>": t("settings.inject.prefix.nested"), ">": t("settings.inject.prefix.plain") } } },
        { name: t("settings.inject.timeFormat"), control: { type: "dropdown", key: "injectTimeFormat", options: { "24h": t("settings.inject.timeFormat.24h"), "12h": t("settings.inject.timeFormat.12h") } } },
        { name: t("settings.reminders"), control: { type: "toggle", key: "remindersEnabled" } },
        { name: t("settings.folderName"), control: { type: "text", key: "folder" } },
      ]),
      this.groupOf(t("settings.section.defaults"), [
        { name: t("settings.defaultCategory"), control: { type: "text", key: "defaultCategory" } },
        { name: t("settings.defaultReminder"), control: { type: "text", key: "defaultReminderMinutes" } },
        { name: t("settings.security.note.name"), desc: t("settings.security.note.desc") },
        { name: t("settings.debug.name"), control: { type: "toggle", key: "debugLogging" } },
        {
          name: t("settings.reset.name"),
          desc: t("settings.reset.desc"),
          searchable: false,
          render: (setting: Setting) => {
            setting.setName(t("settings.reset.name")).setDesc(t("settings.reset.desc"));
            setting.addButton((b) =>
              b.setButtonText(t("settings.reset.button")).onClick(async () => {
                const c = await askChoice(this.app, t("settings.reset.confirm"), [
                  { value: "reset", label: t("settings.reset.confirmYes") },
                ]);
                if (c !== "reset") return;
                await this.plugin.resetAllSyncData();
                if (requireApiVersion("1.13.0")) this.update();
              }),
            );
          },
        },
        {
          name: t("support.name"),
          desc: t("support.desc"),
          visible: () => !!String((this.plugin.manifest as unknown as { fundingUrl?: string }).fundingUrl || ""),
          render: (setting: Setting) => {
            setting.setName(t("support.name")).setDesc(t("support.desc"));
            setting.addButton((b) => b.setButtonText(t("support.button")).setCta().onClick(() => window.open(String((this.plugin.manifest as unknown as { fundingUrl?: string }).fundingUrl || ""))));
          },
        },
      ]),
    ];
  }

  getControlValue(key: string): unknown {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    if (key === "autoSyncMinutes") return String(s.autoSyncMinutes);
    if (key === "weekStart") return String(s.weekStart);
    if (key === "accent") return ["ios", "theme"].includes(String(s.accent)) ? s.accent : "custom";
    return s[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    if (key === "lang") {
      s.lang = value;
      await this.plugin.saveSettings();
      this.plugin.applyLanguage();
      // 1.13 声明式框架缓存了 getSettingDefinitions() 的结果,语言变更后必须通知重取,否则页面停留旧语言。
      if (requireApiVersion("1.13.0")) this.update();
      return;
    }
    if (key === "autoSyncMinutes") { s.autoSyncMinutes = Number(value); await this.plugin.saveSettings(); this.plugin.restartAutoSync(); return; }
    if (key === "accent") { s.accent = value === "custom" ? "#007aff" : String(value); await this.plugin.saveSettings(); this.plugin.refreshPanels(); return; }
    if (key === "weekStart") { s.weekStart = value === "0" ? 0 : 1; await this.plugin.saveSettings(); this.plugin.refreshPanels(); return; }
    if (key === "folder") { s.folder = String(value).trim() || "Agenda"; await this.plugin.saveSettings(); return; }
    if (key === "injectPrefix") { s.injectPrefix = value === ">" ? ">" : ">>"; await this.plugin.saveSettings(); return; }
    if (key === "injectTimeFormat") { s.injectTimeFormat = value === "12h" ? "12h" : "24h"; await this.plugin.saveSettings(); return; }
    if (key === "defaultReminderMinutes") {
      const n = Number.parseInt(String(value), 10);
      s.defaultReminderMinutes = Number.isFinite(n) ? n : -1;
      await this.plugin.saveSettings();
      return;
    }
    if (key in s) { s[key] = value; await this.plugin.saveSettings(); }
  }
}
