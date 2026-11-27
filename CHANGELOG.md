# 更新记录

## 0.10.20 — 2026-11-28

### 中文

- 保留对 Obsidian 1.7.2 的支持，按版本读取界面语言与月度诊断缓存。损坏的缓存条目会被跳过。
- 校验重复日程的单次例外和日记中的跳过标记。更新跳过、恢复按钮以及设置页的刷新方式。
- 简化月视图和编辑器样式，保留三条日程的默认行高、跨月分界和标题输入时的无外框样式。备注使用原生换行。
- 补充英文安装与使用说明。

### English

- Keep support for Obsidian 1.7.2. Language detection and monthly diagnostics use the APIs available in each version. Invalid diagnostic entries are skipped.
- Validate recurring event overrides and skipped-task markers. Update the daily-note buttons and settings refresh.
- Simplify the month view and editor styles while preserving three event slots per week, month boundaries and the title field’s focus appearance. Notes use native line breaks.
- Add English installation and usage instructions.

## 0.10.19 — 2026-11-27

### 中文

- 月视图每周默认预留三条日程的高度。标题保持单行，更多日程可在当天展开。跨月日期用淡底和月份标记区分，交界处使用弧线。
- 更新新建和编辑日程窗口。起止时间对齐，分类沿用日历配色，提醒说明放在输入框下方，保存按钮移到右下角。输入标题时去除蓝色外框。
- 切换“全天”后再切回定时日程，会恢复原来的起止时刻。
- 月度笔记将重复日程和无法解析的条目分开统计。保存时会检查最新内容，保留其他设备的并发修改及手写段落。

### English

- Month view reserves three event rows per week. Titles stay on one line, and extra events expand in place. Muted dates, month labels and curved boundaries distinguish adjacent months.
- The event editor aligns start and end times, uses calendar colors for categories, and places reminder guidance below the field. Save sits at the bottom right. The title field no longer shows a blue focus frame.
- Switching all-day mode on and off restores the original start and end times.
- Monthly notes report duplicates separately from unreadable entries. Saves check the latest note contents to preserve concurrent edits and handwritten sections.

## 0.10.18 — 2026-10-22

- 新增日记自动待办的“跳过”和“恢复”按钮，按日程实例保留跳过记录；不修改日历或完成状态。
- 修正 Tasks 排序后按钮定位，保留未保存输入，并支持编辑器原生撤销。
- 修正 iCloud 集合元数据误判，日历资源真正不完整时仍暂停同步以保留本地数据。
- 加强 CalDAV 条件写入、冲突处理及失败统计，避免 HTTP 412 时覆盖远端内容。
- 补全 ICS 时间戳及提醒描述。

- 自动注入只补充缺失日程，保留已有条目、完成状态和顺序。
- 手动注入用逐行隐藏标记识别插件条目，保留手写待办和无法确认归属的历史条目。
- 关闭重复日程的移动选择窗口后，不再保存移动。
- 保留远端重复日程的单次修改，并支持笔记保存、ICS 导出及同步回写；编辑或取消例外不会覆盖整个系列。
- ICS 订阅中已删除的事件会从本地清理；存在解析失败时暂停删除并报告错误。
- 跨午夜及跨日的重复日程按日期显示完整的延续部分。
- 已取消的日程不再提醒，跨午夜显示切片不会产生额外午夜提醒。
- 新增离线测试入口及对应回归用例。

验证：679 项离线检查、TypeScript 类型检查及生产构建通过；另已在 Obsidian 中验证跳过、恢复、正文输入保护及 Tasks 未完成查询移除跳过项。
