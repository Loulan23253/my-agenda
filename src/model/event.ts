/** v2 事件模型:面向用户的干净结构,不含任何同步元数据(那些在账本里)。 */

export type EventId = string; // 形如 "xxxxxxxx@myagenda"

export interface Recurrence {
  /** iCalendar RRULE 字符串,如 "FREQ=WEEKLY;BYDAY=MO,WE"。 */
  rule: string;
}

export interface CalendarEvent {
  id: EventId;
  title: string;
  /** 本地墙钟 ISO:全天事件为 "YYYY-MM-DD",定时事件为 "YYYY-MM-DDTHH:MM:SS"。 */
  startsAt: string;
  /** 全天事件按 iCalendar 语义为排他结尾日期;定时事件为结束时刻。 */
  endsAt?: string;
  isAllDay: boolean;
  timeZone?: string;
  place?: string;
  /** 用户自由文本(笔记块内的正文)。 */
  notes?: string;
  category?: string;
  /** 组织者(如 "张三 <z@x.com>" 或纯名字)。 */
  organizer?: string;
  /** 参会人列表。 */
  attendees?: string[];
  /** 事件链接。 */
  url?: string;
  /** 确认状态:confirmed/tentative/cancelled(与服务器的 STATUS 属性互通)。 */
  status?: string;
  repeats?: Recurrence;
  /** 同 UID 的 RECURRENCE-ID 例外，随主系列一起存储与同步。 */
  recurrenceOverrides?: CalendarEvent[];
  /** 此例外原本所属的实例时刻。 */
  recurrenceId?: string;
  /** 被排除的实例日期(与 startsAt 同格式)。 */
  skippedDates?: string[];
  /** 提前提醒的分钟数;0 = 事件开始时。 */
  reminderMinutes?: number[];
}

/** 参与指纹与同步的字段快照(账本 pushedFingerprint 的计算对象)。 */
export type EventFingerprintInput = Pick<
  CalendarEvent,
  "title" | "startsAt" | "endsAt" | "isAllDay" | "place" | "notes" | "category" | "repeats" | "skippedDates" | "reminderMinutes"
>;
