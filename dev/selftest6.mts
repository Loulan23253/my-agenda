// v1 残留清理:用用户真实笔记的残留形态做单测
import { stripLegacyFromDaily, stripLegacyFromMonthly } from "../src/data/legacy-clean.ts";

let pass = 0; const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else fails.push(`${name}: got ${g}, want ${w}`);
};

// 真实形态(来自用户 09-28 日记):v2 块与 v1 块相邻,后随空行与 [!callout]
const daily = `> [!todo]+ todo
><!--ag2-injected-->
>>- [ ] 20:00-21:00 gjcch

><!--agenda-injected-->
>>- [ ] 14:00-16:00 mth207 📍ma418 🏷️工作
>>- [ ] 16:00-18:00 mth206 📍eb111 🏷️工作

> [!callout]
> 内容保留`;
const [d1, c1] = stripLegacyFromDaily(daily);
eq("日记:清理块数", c1, 3); // 1 标记 + 2 条目
eq("日记:v2 块保留", d1.includes("20:00-21:00 gjcch"), true);
eq("日记:v1 块移除", d1.includes("mth207"), false);
eq("日记:后续内容保留", d1.includes("> 内容保留"), true);
const [d2, c2] = stripLegacyFromDaily("无残留的笔记");
eq("日记:无残留零计数", c2, 0);
eq("日记:无残留原样", d2, "无残留的笔记");

// 真实形态(来自用户月度文件):v2 字段与 v1 遗留字段混排
const monthly = `## 18:30–20:00 mth212 Class Test
- category:: 会议
- id:: e2b4e7d2-8b35@ogenda
- starts:: 2026-10-20T22:30:00
- ends:: 2026-10-21T00:00:00
- allday:: false
- uid:: e2b4e7d2-8b35@ogenda
- title:: mth212 Class Test
- start:: 2026-10-20T18:30:00
- end:: 2026-10-20T20:00:00
- all_day:: false
- origin:: synced
- etag:: "mul1ey77"
- href:: https://example/e2b4e7d2.ics`;
const [m1, m2c] = stripLegacyFromMonthly(monthly);
eq("月度:清理行数", m2c, 8);
eq("月度:v2 字段保留", m1.includes("- id:: e2b4e7d2-8b35@ogenda") && m1.includes("- starts::"), true);
eq("月度:遗留字段移除", !m1.includes("- uid::") && !m1.includes("- start:: ") && !m1.includes("- etag::") && !m1.includes("- href::"), true);
eq("月度:标题行保留", m1.startsWith("## 18:30–20:00"), true);
// 警惕误伤:v2 合法字段不能被清
const [m3, c3] = stripLegacyFromMonthly("- starts:: x\n- ends:: y\n- allday:: false");
eq("月度:v2 starts/ends/allday 不误伤", c3, 0);

console.log(`清理单测:${pass} 通过,${fails.length} 失败`);
for (const f of fails) console.log("  ✗", f);
if (fails.length) process.exit(1);
