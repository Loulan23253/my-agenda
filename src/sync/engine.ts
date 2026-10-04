import { t } from "../l10n/strings";
import type { Http, DavAuth } from "./dav";
import { authHeaders } from "./dav";
import type { CalendarEvent, EventId } from "../model/event";
import { contentFingerprint } from "../model/content-fingerprint";
import type { MonthlyNoteStore } from "../data/note-store";
import type { SyncJournal, JournalEntry } from "../data/journal";
import { journalPut, journalRemove } from "../data/journal";
import { parseIcsToEvents } from "./ical";
import { buildSingleIcs } from "./ics-build";

const XML_CT = "application/xml; charset=utf-8";
const PACE_MS = 250;
const RETRY_503 = [2000, 5000];

export interface CalendarRoute {
  id: string;
  url: string;
  name: string;
  category: string;
  auth: DavAuth;
}

export interface ConflictInfo {
  title: string;
  mine: string;
  theirs: string;
}

export type ConflictChoice = "mine" | "theirs" | null;

export interface EngineDeps {
  http: Http;
  routes: CalendarRoute[];
  notes: MonthlyNoteStore;
  journal: SyncJournal;
  saveJournal(): Promise<void>;
  askConflict(info: ConflictInfo): Promise<ConflictChoice>;
  /** 日历在远端已不存在(404)时询问:是否移除其配置与本地日程。缺省时仅静默跳过。 */
  askCalendarsDeleted?: (names: string[]) => Promise<boolean>;
  notify(msg: string): void;
  sleep(ms: number): Promise<void>;
}

export interface SyncSummary {
  pulled: number;
  pushed: number;
  created: number;
  deleted: number;
  conflicts: number;
  adopted: number;
  months: string[];
}

interface RemoteItem {
  event: CalendarEvent;
  href: string;
  etag: string;
}

interface ScanResult {
  byUid: Map<EventId, RemoteItem>;
  /** 服务器已删除的资源 href。 */
  deletedHrefs: Set<string>;
  tokens: Record<string, string | undefined>;
  /** 远端已不存在的日历(404,通常是被用户在 Apple 日历中删除)。 */
  missing: CalendarRoute[];
  /** 本轮做过全量 REPORT 的日历 id:只有这些日历的"缺席"才可信为已删除。 */
  complete: Set<string>;
}


function resourceUrl(calendarUrl: string, uid: string): string {
  return calendarUrl.replace(/\/?$/, "/") + encodeURIComponent(uid) + ".ics";
}

function describe(ev: CalendarEvent): string {
  return `${ev.startsAt.replace("T", " ").slice(0, 16)} ${ev.title}`;
}

function monthKey(startsAt: string): string {
  return startsAt.slice(0, 7);
}

function firstHeader(headers: Record<string, string>, name: string): string | undefined {
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return hit?.[1];
}

export class SyncEngine {
  constructor(private readonly deps: EngineDeps) {}

  // ── SCAN:逐日历拉取远端状态(游标增量优先,回退全量)──

  private async scan(): Promise<ScanResult> {
    const { deps } = this;
    const byUid = new Map<EventId, RemoteItem>();
    const deletedHrefs = new Set<string>();
    const tokens: Record<string, string | undefined> = {};
    const missing: CalendarRoute[] = [];
    const complete = new Set<string>();

    for (const route of deps.routes) {
      const token = deps.journal.calendars[route.id]?.syncToken;
      let incrementalOk = false;

      if (token) {
        try {
          const res = await deps.http({
            url: route.url,
            method: "REPORT",
            headers: authHeaders(route.auth, { Depth: "1", "Content-Type": XML_CT }),
            body:
              `<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
              `<d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level>` +
              `<d:prop><d:getetag/></d:prop></d:sync-collection>`,
          });
          if (res.status === 404) {
            if (!missing.find((r) => r.id === route.id)) missing.push(route);
            continue;
          }
          if (res.status >= 200 && res.status < 300) {
            incrementalOk = true;
            const newToken = parseSyncToken(res.text);
            tokens[route.id] = newToken || undefined;
            const entries = parseSyncChanges(res.text);
            const changed = entries.filter((e) => !e.deleted).map((e) => new URL(e.href, route.url).toString());
            for (const entry of entries) if (entry.deleted) deletedHrefs.add(new URL(entry.href, route.url).toString());

            // calendar-multiget 合并取回(≤100/批);任一批失败 → 回退逐条 GET
            const fetched = new Set<string>();
            let multigetOk = changed.length > 0;
            for (let i = 0; i < changed.length && multigetOk; i += 100) {
              const batch = changed.slice(i, i + 100);
              try {
                const mg = await deps.http({
                  url: route.url,
                  method: "REPORT",
                  headers: authHeaders(route.auth, { Depth: "1", "Content-Type": XML_CT }),
                  body:
                    `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
                    `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
                    batch.map((h) => `<d:href>${h.replace(/&/g, "&amp;")}</d:href>`).join("") +
                    `</c:calendar-multiget>`,
                });
                if (mg.status < 200 || mg.status >= 300) { multigetOk = false; break; }
                const items = parseMultistatusCalendarData(mg.text, route.url);
                if (items.length === 0 && batch.length > 0) { multigetOk = false; break; }
                for (const item of items) { byUid.set(item.event.id, item); fetched.add(item.href); }
              } catch {
                multigetOk = false;
              }
            }
            if (!multigetOk) {
              for (const full of changed) {
                if (fetched.has(full)) continue;
                const icsRes = await deps.http({ url: full, method: "GET", headers: authHeaders(route.auth) });
                if (icsRes.status >= 200 && icsRes.status < 300) {
                  for (const ev of parseIcsToEvents(icsRes.text)) {
                    byUid.set(ev.id, {
                      event: ev,
                      href: full,
                      etag: firstHeader(icsRes.headers, "etag") ?? `"${icsRes.text.length}"`,
                    });
                  }
                }
              }
            }
          }
        } catch {
          incrementalOk = false; // 游标同步不可用 → 整个日历回退全量
        }
      }

      if (!incrementalOk) {
        const res = await deps.http({
          url: route.url,
          method: "REPORT",
          headers: authHeaders(route.auth, { Depth: "1", "Content-Type": XML_CT }),
          body:
            `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
            `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
            `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter>` +
            `</c:calendar-query>`,
        });
        if (res.status === 404) {
          if (!missing.find((r) => r.id === route.id)) missing.push(route);
          continue;
        }
        if (res.status < 200 || res.status >= 300) {
          deps.notify(`日历「${route.name || route.id}」拉取失败(HTTP ${res.status})`);
          continue;
        }
        tokens[route.id] = undefined;
        complete.add(route.id);
        for (const item of parseMultistatusCalendarData(res.text, route.url)) {
          byUid.set(item.event.id, item);
        }
      }
    }
    return { byUid, deletedHrefs, tokens, missing, complete };
  }

  // ── 主流程 ──

  async run(): Promise<SyncSummary> {
    const { deps } = this;
    const summary: SyncSummary = { pulled: 0, pushed: 0, created: 0, deleted: 0, conflicts: 0, adopted: 0, months: [] };
    const read = await deps.notes.loadAll();
    const local = read.events;
    const remote = await this.scan();

    // 日历在 iCloud 上已被删除(404):询问用户是否移除配置与本地日程
    if (remote.missing.length && deps.askCalendarsDeleted) {
      const remove = await deps.askCalendarsDeleted(remote.missing.map((r) => r.name || r.id));
      if (remove) {
        for (const r of remote.missing) {
          for (const [id, entry] of Object.entries(deps.journal.events)) {
            if (entry.calendarId === r.id) journalRemove(deps.journal, id);
          }
          delete deps.journal.calendars[r.id];
        }
        await deps.saveJournal();
      }
    }
    const remoteByUid = remote.byUid;

    const pickRoute = (ev: CalendarEvent): CalendarRoute | undefined => {
      const cat = (ev.category ?? "").trim();
      if (cat) {
        const hit = deps.routes.find((r) => r.category.trim() === cat);
        if (hit) return hit;
      }
      return deps.routes[0];
    };
    const routeById = (id: string): CalendarRoute | undefined => deps.routes.find((r) => r.id === id);
    // URL 归一化比较:防尾斜杠差异导致的误配(如 .../cal 误配 .../calendar2)
    const ownerOf = (href: string): CalendarRoute | undefined =>
      deps.routes.find((r) => href.startsWith(r.url) || href.startsWith(r.url.replace(/\/$/, "") + "/"));

    interface PushJob {
      ev: CalendarEvent;
      route: CalendarRoute;
      ifMatch?: string;
      isNew: boolean;
    }
    const toPush: PushJob[] = [];
    const toApply: CalendarEvent[] = [];
    const toDeleteRemote: { id: EventId; href: string; etag: string }[] = [];
    const dropLocally = new Set<EventId>();
    const localIds = new Set(local.map((e) => e.id));

    // ① 逐条本地日程做三方对账
    for (const ev of local) {
      const entry: JournalEntry | undefined = deps.journal.events[ev.id];
      const remoteItem = remoteByUid.get(ev.id);

      if (remote.deletedHrefs.has(entry?.href ?? "")) {
        // 服务器已删除该资源 → 跟随删除(本地块 + 账本)
        dropLocally.add(ev.id);
        journalRemove(deps.journal, ev.id);
        continue;
      }

      if (!entry) {
        if (remoteItem) {
          // 收养:服务器已有此 uid(v1 时代同步过)。内容一致 → 仅登记;不一致 → 本地版本优先推送
          const remoteFp = await contentFingerprint(remoteItem.event);
          journalPut(deps.journal, ev.id, {
            calendarId: pickRoute(ev)?.id ?? "",
            href: remoteItem.href,
            etag: remoteItem.etag,
            pushedFingerprint: remoteFp,
            state: "synced",
          });
          summary.adopted++;
          if ((await contentFingerprint(ev)) !== remoteFp) {
            const route = pickRoute(ev);
            if (route) toPush.push({ ev, route, ifMatch: remoteItem.etag, isNew: false });
          }
        } else {
          const route = pickRoute(ev);
          if (route) toPush.push({ ev, route, isNew: true });
        }
        continue;
      }

      // "缺席=已删除"只在事件所属日历本轮做过全量拉取时成立;
      // 增量轮只返回有变化的资源,未变化的事件缺席是正常的,绝不能清账本
      const entryRoute = routeById(entry.calendarId);
      const canTrustAbsence = !!entryRoute && remote.complete.has(entryRoute.id);
      const remoteItemExists = remoteItem !== undefined;
      const remoteDeleted = canTrustAbsence && !remoteItemExists;
      const remoteChanged = remoteItemExists && remoteItem.etag !== entry.etag;
      const remoteDirty = remoteDeleted || remoteChanged;
      const localDirty = (await contentFingerprint(ev)) !== entry.pushedFingerprint;

      // 归属校验:远端资源不属于账本登记的日历(同 UID 被复制到多个日历)→
      // 本轮完全跳过该事件,不做任何方向的同步,避免拉取覆盖与跨日历误推
      if (remoteItem && entryRoute && !remoteItem.href.startsWith(entryRoute.url.replace(/\/$/, "") + "/") && !remoteItem.href.startsWith(entryRoute.url)) {
        deps.notify(`日程「${ev.title}」在多个日历中重复,已跳过同步`);
        continue;
      }
      if (!entryRoute) {
        // 停用/未知日历:数据原地保留,不推送不拉取
        continue;
      }
      const route = entryRoute;

      if (localDirty && remoteDirty) {
        summary.conflicts++;
        const pick = await deps.askConflict({
          title: ev.title,
          mine: describe(ev),
          theirs: remoteDeleted ? t("sync.serverDeleted") : describe(remoteItem?.event ?? ev),
        });
        if (pick === "mine") {
          if (remoteDeleted) {
            toPush.push({ ev, route, isNew: true }); // 服务器没了 → 重新创建
          } else {
            toPush.push({ ev, route, ifMatch: remoteItem?.etag, isNew: false });
          }
        } else if (remoteDeleted) {
          dropLocally.add(ev.id);
          journalRemove(deps.journal, ev.id);
          summary.deleted++;
        } else if (remoteItem) {
          toApply.push(remoteItem.event);
          journalPut(deps.journal, ev.id, {
            ...entry,
            etag: remoteItem.etag,
            pushedFingerprint: await contentFingerprint(remoteItem.event),
          });
        }
        continue;
      }
      if (localDirty) {
        const route = routeById(entry.calendarId);
        if (!route) continue; // 该日历已停用:事件暂停同步(本地与远端数据都保留)
        // isNew 仅在全量确认远端缺席时成立;增量轮"未返回"≠"不存在"——
        // 按 isNew=true 推到 uid 落点 URL 会在服务器留下同 UID 双资源
        toPush.push({ ev, route, ifMatch: remoteItem?.etag, isNew: remoteDeleted });
      } else if (remoteDirty) {
        if (remoteItem) {
          toApply.push(remoteItem.event);
          journalPut(deps.journal, ev.id, {
            ...entry,
            etag: remoteItem.etag,
            pushedFingerprint: await contentFingerprint(remoteItem.event),
          });
          summary.pulled++;
        } else {
          dropLocally.add(ev.id);
          journalRemove(deps.journal, ev.id);
          summary.deleted++;
        }
      }
    }

    // ② 远端新增(本地与账本都没见过)
    for (const [id, item] of remoteByUid) {
      if (localIds.has(id) || deps.journal.events[id]) continue;
      toApply.push(item.event);
      journalPut(deps.journal, id, {
        calendarId: ownerOf(item.href)?.id ?? "",
        href: item.href,
        etag: item.etag,
        pushedFingerprint: await contentFingerprint(item.event),
        state: "synced",
      });
      summary.pulled++;
    }

    // ③ 本地已删除(账本仍在)→ 删除远端
    // 本轮刚拉取/收养(toApply)与待推送(toPush)的事件不在 localIds(加载先于收养),
    // 但绝不能被当"本地已删"清掉——否则 iPhone 上新建的日程会被下一轮同步当场吃掉。
    const touched = new Set<string>([...toApply.map((x) => x.id), ...toPush.map((j) => j.ev.id)]);
    for (const [id, entry] of Object.entries(deps.journal.events)) {
      if (localIds.has(id) || dropLocally.has(id) || touched.has(id)) continue;
      // 账本里有、本地没有:本地删除待传播(pendingDelete)或异常消失,统一对远端执行删除。
      // 注意:增量扫描(sync-token)不返回"自上次令牌后未变"的资源,此时不能凭空丢条目,
      // 否则远端残留、下轮全量拉取会把事件"复活"——用账本里已知的 href 兜底删除。
      const remoteItem = remoteByUid.get(id);
      if (remoteItem) {
        toDeleteRemote.push({ id, href: remoteItem.href, etag: remoteItem.etag });
      } else if (entry.state === "pendingDelete" && entry.href) {
        toDeleteRemote.push({ id, href: entry.href, etag: entry.etag ?? "" });
      } else if (remote.complete.has(entry.calendarId)) {
        // 全量轮确认远端也没有 → 真删除,清账本
        journalRemove(deps.journal, id);
      } else if (entry.href) {
        // 增量轮:远端"未返回"≠"不存在"(未变化的资源不进响应)。
        // 必须用账本 href 兜底 DELETE;直接清账本会让全量轮把事件当新增拉回复活
        toDeleteRemote.push({ id, href: entry.href, etag: entry.etag ?? "" });
      } else {
        journalRemove(deps.journal, id);
      }
    }

    // 服务器已删除的事件:本地块真正移除(否则下轮无账本会被当新增复活)
    if (dropLocally.size) {
      await deps.notes.removeByUids(dropLocally);
      for (let i = local.length - 1; i >= 0; i--) if (dropLocally.has(local[i].id)) local.splice(i, 1);
      for (const id of dropLocally) localIds.delete(id);
    }

    // ④ 先落盘"拉取/收养"(本地写),再发布服务器写
    // 分类跟随日历映射:日历配置了分类时,覆盖事件自带的 VEVENT CATEGORIES,
    // 保证"上课"日历下的事件始终显示为该日历的分类,不被历史 CATEGORIES 污染。
    // 覆盖后同步回写指纹,避免下一轮因指纹差异产生冗余推送
    for (const ev of toApply) {
      const entry = deps.journal.events[ev.id];
      const route = entry ? routeById(entry.calendarId) : undefined;
      const cat = route?.category?.trim();
      if (cat && ev.category !== cat) {
        ev.category = cat;
        if (entry) entry.pushedFingerprint = await contentFingerprint(ev);
      }
    }
    if (toApply.length) {
      const applied = new Map(toApply.map((x) => [x.id, x]));
      const merged = local.map((e) => applied.get(e.id) ?? e);
      for (const [id, ev] of applied) if (!local.some((e) => e.id === id)) merged.push(ev);
      const affected = new Set<string>();
      for (const [id, ev] of applied) {
        affected.add(monthKey(ev.startsAt));
        const old = local.find((e) => e.id === id);
        if (old) affected.add(monthKey(old.startsAt));
      }
      for (const month of affected) {
        const preamble = await deps.notes.readMonthPreamble(month);
        await deps.notes.writeMonth(month, merged, preamble);
        summary.months.push(month);
      }
    }

    // ⑤ PUBLISH:推回 + 删除(带节奏与 503 重试;单个失败不中断)
    let writes = 0;
    const pace = async () => {
      if (writes++ > 0) await deps.sleep(PACE_MS);
    };
    const putWith503 = async (auth: DavAuth, url: string, body: string, ifMatch?: string) => {
      const headers = { ...authHeaders(auth, { "Content-Type": "text/calendar; charset=utf-8" }), ...(ifMatch ? { "If-Match": ifMatch } : {}) };
      let res = await deps.http({ url, method: "PUT", headers, body });
      for (const delay of RETRY_503) {
        if (res.status !== 503) break;
        await deps.sleep(delay);
        res = await deps.http({ url, method: "PUT", headers, body });
      }
      return res;
    };

    for (const job of toPush) {
      await pace();
      try {
        const entry = deps.journal.events[job.ev.id];
        const url = job.isNew || !entry?.href ? resourceUrl(job.route.url, job.ev.id) : entry.href;
        const ics = buildSingleIcs(job.ev);
        const res = await putWith503(job.route.auth, url, ics, job.isNew ? undefined : job.ifMatch);
        if (res.status >= 200 && res.status < 300) {
          journalPut(deps.journal, job.ev.id, {
            calendarId: job.route.id,
            href: url,
            etag: firstHeader(res.headers, "etag") ?? `"${ics.length}"`,
            pushedFingerprint: await contentFingerprint(job.ev),
            state: "synced",
          });
          if (job.isNew) summary.created++;
          else summary.pushed++;
        } else if (res.status === 412 || res.status === 403) {
          // 条件写入被拒:etag 已过期(服务器端有变动)。拉取最新内容做指纹对比:
          // 一致 → 只是 etag 过期,更新账本即可;不一致 → 真冲突,按策略留给下轮
          const fresh = await deps.http({ url, method: "GET", headers: authHeaders(job.route.auth) });
          if (fresh.status >= 200 && fresh.status < 300) {
            const remoteEv = parseIcsToEvents(fresh.text)[0];
            const remoteFp = remoteEv ? await contentFingerprint(remoteEv) : "";
            const localFp = await contentFingerprint(job.ev);
            if (remoteFp === localFp) {
              journalPut(deps.journal, job.ev.id, {
                calendarId: job.route.id,
                href: url,
                etag: firstHeader(fresh.headers, "etag") ?? `"${fresh.text.length}"`,
                pushedFingerprint: localFp,
                state: "synced",
              });
              continue;
            }
            // 内容确实不同:服务器有别人的新版本,而 sync-token 增量已错过它 → 当场按策略解决
            const pick = await deps.askConflict({
              title: job.ev.title,
              mine: describe(job.ev),
              theirs: remoteEv ? describe(remoteEv) : t("sync.serverDeleted"),
            });
            if (pick === "theirs" && remoteEv) {
              const loaded = await deps.notes.loadAll();
              const merged = loaded.events.map((e) => (e.id === remoteEv.id ? remoteEv : e));
              if (!merged.some((e) => e.id === remoteEv.id)) merged.push(remoteEv);
              const month = monthKey(remoteEv.startsAt);
              await deps.notes.writeMonth(month, merged, await deps.notes.readMonthPreamble(month));
              journalPut(deps.journal, job.ev.id, {
                calendarId: job.route.id,
                href: url,
                etag: firstHeader(fresh.headers, "etag") ?? `"${fresh.text.length}"`,
                pushedFingerprint: remoteFp,
                state: "synced",
              });
              summary.conflicts++;
              continue;
            }
            if (pick === "mine") {
              const retry = await putWith503(job.route.auth, url, ics);
              if (retry.status >= 200 && retry.status < 300) {
                journalPut(deps.journal, job.ev.id, {
                  calendarId: job.route.id,
                  href: url,
                  etag: firstHeader(retry.headers, "etag") ?? `"${ics.length}"`,
                  pushedFingerprint: localFp,
                  state: "synced",
                });
                summary.pushed++;
                continue;
              }
            }
            deps.notify(`「${job.ev.title}」冲突未解决,保留本地待同步`);
            continue;
          }
          // 服务器没有此资源(内容被拒或从未建成)→ 如实提示,不再谎称"下轮拉取"
          deps.notify(`「${job.ev.title}」推送被拒(HTTP ${res.status}),内容未上传`);
        } else {
          deps.notify(`「${job.ev.title}」推送失败(HTTP ${res.status})`);
        }
      } catch (e) {
        deps.notify(`「${job.ev.title}」推送异常:${msg(e)}`);
      }
    }

    for (const del of toDeleteRemote) {
      await pace();
      try {
        // 用该日程所属日历的凭据(多日历账号可能不同);
        // 匹配不到启用日历(已停用/已移除)时不删除,保留账本条目,恢复同步后继续
        const route = ownerOf(del.href);
        if (!route) continue;
        const auth = route.auth;
        let res = await deps.http({
          url: del.href,
          method: "DELETE",
          headers: authHeaders(auth, del.etag ? { "If-Match": del.etag } : {}),
        });
        if (res.status === 403 || res.status === 412) {
          // etag 过期:GET 刷新后再删一次(仍失败则下轮再试)
          const fresh = await deps.http({ url: del.href, method: "GET", headers: authHeaders(auth) });
          const curEtag = fresh.status >= 200 && fresh.status < 300 ? firstHeader(fresh.headers, "etag") : undefined;
          if (curEtag && curEtag !== del.etag) {
            res = await deps.http({
              url: del.href,
              method: "DELETE",
              headers: authHeaders(auth, curEtag ? { "If-Match": curEtag } : {}),
            });
          }
        }
        if ((res.status >= 200 && res.status < 300) || res.status === 404) {
          journalRemove(deps.journal, del.id);
          await deps.notes.removeByUids(new Set([del.id]));
          summary.deleted++;
        } else {
          deps.notify(`删除失败(HTTP ${res.status})`);
        }
      } catch (e) {
        deps.notify(`删除异常:${msg(e)}`);
      }
    }

    for (const [id, token] of Object.entries(remote.tokens)) {
      const url = deps.routes.find((r) => r.id === id)?.url ?? "";
      if (token) deps.journal.calendars[id] = { url, syncToken: token };
      else if (deps.journal.calendars[id]) deps.journal.calendars[id] = { url, syncToken: "" };
    }

    await deps.saveJournal();
    return summary;
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── multistatus 解析助手 ──

function localName(el: Element): string {
  return el.localName ?? el.tagName.replace(/^.*:/, "");
}

function parseSyncToken(xml: string): string | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (localName(el) === "sync-token") return (el.textContent || "").trim() || null;
  }
  return null;
}

interface SyncChange {
  href: string;
  deleted: boolean;
}

function parseSyncChanges(xml: string): SyncChange[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out: SyncChange[] = [];
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (localName(el) !== "response") continue;
    let href = "";
    let hasEtag = false;
    let status404 = false;
    for (const child of Array.from(el.getElementsByTagName("*"))) {
      const tag = localName(child);
      if (tag === "href" && !href) href = (child.textContent || "").trim();
      else if (tag === "getetag") hasEtag = true;
      else if (tag === "status" && (child.textContent || "").includes("404")) status404 = true;
    }
    if (href) out.push({ href, deleted: !hasEtag || status404 });
  }
  return out;
}

function parseMultistatusCalendarData(xml: string, baseUrl: string): RemoteItem[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out: RemoteItem[] = [];
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (localName(el) !== "response") continue;
    let href = "";
    let etag = "";
    let ics = "";
    for (const child of Array.from(el.getElementsByTagName("*"))) {
      const tag = localName(child);
      if (tag === "href" && !href) href = (child.textContent || "").trim();
      else if (tag === "getetag" && !etag) etag = (child.textContent || "").trim();
      else if (tag === "calendar-data" && !ics) ics = (child.textContent || "").trim();
    }
    if (!href || !ics) continue;
    const full = new URL(href, baseUrl).toString();
    for (const ev of parseIcsToEvents(ics)) {
      out.push({ event: ev, href: full, etag });
    }
  }
  return out;
}
