# MyAgenda

Obsidian 日程插件，支持 CalDAV / iCloud 双向同步、ICS 订阅、重复日程、提醒，以及将当日日程注入日记。

## 安装

需要 Obsidian 1.7.2 或更高版本。

1. 从仓库 Release 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 将这三个文件放入笔记库的 `.obsidian/plugins/myagenda/` 文件夹。
3. 在 Obsidian 的第三方插件设置中启用 MyAgenda；更新后重新加载插件。
4. 在插件设置中配置日程文件夹及日历来源。iCloud 使用 App 专用密码。

日程按月保存为 Markdown，同步元数据保存在日程文件夹内的 `.myagenda/journal.json`。账户设置保存在本机 `data.json`，该文件不应上传到仓库。

## 日记注入

在 `YYYY-MM-DD.md` 日记中添加设置指定的标记行，默认如下：

```markdown
> [!todo]+ todo
```

自动注入会保留已有条目并补充缺失日程。手动注入会重建带有插件归属标记的条目并保留勾选状态。手写待办会保留；旧版本中无法确认归属的条目也会保留，避免误删。

不想做的日程，直接点自动待办旁的“跳过”按钮即可。跳过后会显示“已跳过 N 项”和“恢复”入口，一项可一键恢复，多项则选择要恢复的记录。编辑和阅读模式均可使用；手写待办不会出现跳过按钮。命令面板中的“MyAgenda：跳过日记中的日程”也可继续使用。跳过只在当前日记隐藏这一次，不会标成完成或修改日历；重新打开、同步和手动重建都不会补回。需要时执行“MyAgenda：恢复日记中跳过的日程”。跳过记录随日记保存，重复日程以后的实例正常注入。

## 开发与验证

使用 Node.js 24：

```sh
npm ci
npm test
npm run build
```

`npm test` 使用内存文件系统和模拟服务器，不读取本机账号，不修改真实笔记或远端日历。构建产物为根目录的 `main.js`。

## 发布

确认版本号后，同步更新 `manifest.json`、`package.json`、`package-lock.json` 和 `versions.json`，运行测试与构建，再推送版本标签。GitHub Actions 会生成带有插件安装文件的草稿 Release；检查后发布。

修复记录见 [CHANGELOG.md](CHANGELOG.md)。
