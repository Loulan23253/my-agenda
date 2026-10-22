// 新特性单测:@地点 #分类 / 注入格式开关
import { parseQuickAdd } from "../src/core/nlp-parse.ts";
import { applyInjection } from "../src/ui/inject.ts";
const MARKER = "> [!todo]+ todo";
const note = () => `---\nx\n---\n\n${MARKER}\n\n> 用户内容\n`;
let pass = 0; const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else fails.push(`${name}: got ${g}, want ${w}`);
};
const now = new Date(2026, 8, 28, 13, 26);

// @地点 #分类
const p1 = parseQuickAdd("明天14:00 牙医 @诊所 #个人", now);
eq("q@:date", p1?.dateKey, "2026-09-29");
eq("q@:title", p1?.title, "牙医");
eq("q@:place", p1?.place, "诊所");
eq("q@:category", p1?.category, "个人");
const p2 = parseQuickAdd("开会@会议室A-2#工作", now);
eq("q2:place 连写", p2?.place, "会议室A-2");
eq("q2:category", p2?.category, "工作");
eq("q2:title 无残留", p2?.title, "开会");
const p3 = parseQuickAdd("普通输入无标签", now);
eq("q3:无标签", p3?.place ?? null, null);

// 注入格式开关
const items = [{ title: "晨会", allDay: false, startTime: "09:00", endTime: "09:30", place: "301", category: "工作" }];
const f1 = applyInjection(note(), { marker: MARKER, items, format: { checkbox: false, place: false, category: false, prefix: ">" } });
eq("无勾选框", /\[ \]/.test(f1.content), false);
eq("前缀 >", /^>- 09:00-09:30 晨会$/m.test(f1.content.replace(/ <!--ag2-item:[^>]*-->/g, "")), true);
eq("隐藏地点", f1.content.includes("301"), false);
const f2 = applyInjection(note(), { marker: MARKER, items, format: { checkbox: true, place: true, category: true, prefix: ">>" } });
eq("默认嵌套+全信息", /^>>- \[ \] 09:00-09:30 晨会 📍301 🏷️工作$/m.test(f2.content.replace(/ <!--ag2-item:[^>]*-->/g, "")), true);
// 开关下勾选保留
const f3 = applyInjection(f2.content.replace("[ ] 09:00", "[x] 09:00"), { marker: MARKER, items, force: true, preserveChecked: true, format: { checkbox: true, place: true, category: true, prefix: ">>" } });
eq("勾选仍跨重建", /\[x\] 09:00-09:30 晨会/.test(f3.content), true);


// ── 12h 时间制式(原型功能补全)──
import { applyInjection as ai } from "../src/ui/inject.ts";
const note12 = () => `---\nx\n---\n\n${MARKER}\n\n`;
const f12 = ai(note12(), { marker: MARKER, items: [
  { title: "晨会", allDay: false, startTime: "09:00", endTime: "10:30" },
  { title: "晚班", allDay: false, startTime: "21:30", endTime: "22:00" },
], force: true, format: { checkbox: true, place: false, category: false, prefix: ">>", timeFormat: "12h" } });
eq("12h:上午跨段", /9:00 AM-10:30 AM 晨会/.test(f12.content), true);
eq("12h:下午转 PM", /9:30 PM-10:00 PM 晚班/.test(f12.content), true);
const f24 = ai(note12(), { marker: MARKER, items: [{ title: "晨会", allDay: false, startTime: "09:00", endTime: "10:30" }], force: true, format: { checkbox: true, place: false, category: false, prefix: ">>", timeFormat: "24h" } });
eq("24h:不变", /09:00-10:30 晨会/.test(f24.content), true);

console.log(`新特性单测:${pass} 通过,${fails.length} 失败`);
for (const f of fails) console.log("  ✗", f);
if (fails.length) process.exit(1);
