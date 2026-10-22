/**
 * 重复事件拖拽规划(纯函数):
 * - pick = "series":整个系列迁移 —— 锚点移到拖放位置(日期+时刻),规则按新日期重写
 * - pick = "single":仅移动被拖实例 —— 主事件 EXDATE 掉该实例日期,新位置建同内容单次例外
 * 返回应保存的事件集。
 */
import type { CalendarEvent } from "../model/event";
import { dateKey, parseLocal, shiftIsoDays } from "../kernel/dates";
import { rebaseRuleOnMove } from "./recurrence-rebase";

export type RecurMovePick = "series" | "single";

export function planRecurringMove(
  current: CalendarEvent,
  occStart: string,
  startsAt: string,
  endsAt: string | undefined,
  pick: RecurMovePick,
): CalendarEvent[] {
  if (pick === "series") {
    const anchorDay = dateKey(parseLocal(current.startsAt));
    const newDay = dateKey(parseLocal(startsAt));
    const delta = Math.round((parseLocal(newDay).getTime() - parseLocal(anchorDay).getTime()) / 86400_000);
    const newEnd = endsAt ?? (current.endsAt ? shiftIsoDays(current.endsAt, delta) : undefined);
    return [{
      ...current,
      startsAt,
      endsAt: newEnd,
      repeats: { rule: rebaseRuleOnMove(current.repeats!.rule, parseLocal(startsAt)) },
    }];
  }
  const occDay = dateKey(parseLocal(occStart));
  return [
    { ...current, skippedDates: [...new Set([...(current.skippedDates ?? []), occDay])] },
    {
      ...current,
      id: crypto.randomUUID() + "@myagenda",
      repeats: undefined,
      recurrenceOverrides: undefined,
      skippedDates: undefined,
      startsAt,
      endsAt,
    },
  ];
}
