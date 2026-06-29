/**
 * Calendar sync (background only). The durable, official "what changed" engine:
 * runs on a chrome.alarm, lists changes via a sync token, and maintains the set
 * of upcoming visitor (magic-address) events in storage.local. Drives:
 *  - post-save refresh of the open event (changedIds),
 *  - the visitor-event notification + toolbar badge (newMarked / count),
 *  - the side panel's "open from list" picker (listMarked).
 * No DOM. Reflects SAVED state only (pre-save edits are add-on-only — see
 * Planning-docs/2026-06-19_calendar_addon_vs_extension_capabilities.md).
 */
import { MAGIC_ADDRESS } from './config';
import { encodeEid, isMarked, listEvents } from './calendar';
import type { PanelVisitorEvent, VisitorEventSummary } from './types';

const SYNC_TOKEN_KEY = 'auxilio.syncToken';
const MARKED_KEY = 'auxilio.markedEvents';
/** Events the user has already issued passes for from this extension — keyed by
 *  eventId, value = when handled. A durable overlay over the marked set so a
 *  finished event stops badging/notifying/nudging instead of nagging until it
 *  ages out. Local-only signal: passes sent via the add-on or another device
 *  won't appear here (full cross-channel truth needs an engine status endpoint —
 *  deferred). Pruned by HANDLED_TTL_MS. */
const HANDLED_KEY = 'auxilio.handledEvents';
/** iCalUids the ENGINE reports already have an active pass — i.e. handled through
 *  ANY surface (add-on, another device), not just this extension. Overwritten on
 *  each status poll (NOT durable like HANDLED_KEY): if passes are later cancelled
 *  elsewhere, the next poll drops the uid and the event correctly resurfaces. */
const ENGINE_HANDLED_KEY = 'auxilio.engineHandled';
/** When the last FULL (tokenless) re-scan ran. Incremental sync only reports
 *  changes, so an event missed when its change was first consumed (e.g. a
 *  different magic address in an earlier build) is never re-examined until a full
 *  re-scan. We force one periodically + on install so the set self-heals. */
const LAST_FULL_KEY = 'auxilio.lastFullSync';
/** Signature of the sync-relevant config (magic address + query schema) at the
 *  last run, so a plain reload can resume incremental sync instead of paying the
 *  full forward-window scan every time. See syncConfigChanged. */
const CONFIG_SIG_KEY = 'auxilio.configSig';
/** Bump when the events.list query SHAPE changes (e.g. adding timeMax) so the next
 *  load does one clean full re-scan to rebuild the marked set under the new query.
 *  v2 = bounded forward window (timeMax). v3 = organizer-only gate — forces a clean
 *  re-scan that drops events the user is merely a GUEST of, which earlier builds
 *  wrongly marked + nudged. */
const SYNC_SCHEMA_VERSION = 3;
const PAST_GRACE_MS = 60 * 60_000; // keep events until 1h after they end
const HANDLED_TTL_MS = 30 * 24 * 60 * 60_000; // forget "handled" after 30 days
const FULL_RESYNC_INTERVAL_MS = 12 * 60 * 60_000; // re-scan the whole window twice a day

type MarkedMap = Record<string, VisitorEventSummary>;
type HandledMap = Record<string, number>;

async function readMarked(): Promise<MarkedMap> {
  const r = await chrome.storage.local.get(MARKED_KEY);
  return (r[MARKED_KEY] as MarkedMap) ?? {};
}

async function readHandled(): Promise<HandledMap> {
  const r = await chrome.storage.local.get(HANDLED_KEY);
  return (r[HANDLED_KEY] as HandledMap) ?? {};
}

/** Drop the sync token so the next sync does a full tokenless re-scan of the
 *  forward window. Called on a real config change so it takes effect immediately
 *  instead of waiting for the periodic resync. */
export async function clearSyncToken(): Promise<void> {
  await chrome.storage.local.remove([SYNC_TOKEN_KEY, LAST_FULL_KEY]);
}

/** Did the sync-relevant config (magic address or query schema) change since the
 *  last run? That's the ONLY time we must drop the token for a full re-scan. A
 *  plain reload leaves the signature unchanged, so it keeps the token and resumes
 *  cheap incremental sync — instead of re-running the multi-second full scan (which
 *  the MV3 worker can be killed in the middle of) on every reload. Records the new
 *  signature as a side effect. The 12h periodic full re-scan still self-heals drift. */
export async function syncConfigChanged(): Promise<boolean> {
  const sig = `${MAGIC_ADDRESS}|v${SYNC_SCHEMA_VERSION}`;
  const r = await chrome.storage.local.get(CONFIG_SIG_KEY);
  if (r[CONFIG_SIG_KEY] === sig) return false;
  await chrome.storage.local.set({ [CONFIG_SIG_KEY]: sig });
  return true;
}

/** Record that passes were issued for this event — drops it from every nudge
 *  surface (badge, banner, notification, picker) until it ages out. */
export async function markHandled(eventId: string): Promise<void> {
  if (!eventId) return;
  const handled = await readHandled();
  handled[eventId] = Date.now();
  await chrome.storage.local.set({ [HANDLED_KEY]: handled });
}

export async function readEngineHandled(): Promise<Set<string>> {
  const r = await chrome.storage.local.get(ENGINE_HANDLED_KEY);
  return new Set((r[ENGINE_HANDLED_KEY] as string[]) ?? []);
}

/** Has this event already been handled (passes issued) from THIS extension? Reads
 *  the local handled overlay — lets the in-page optimistic nudge skip an event the
 *  user already sent passes for, instead of re-nudging when they reopen/close it
 *  (the sync set already filters handled events, but the optimistic DOM guess
 *  bypasses that filter). engineHandled isn't consulted here: it's keyed by iCalUid,
 *  which the optimistic path doesn't have. */
export async function isEventHandled(eventId: string): Promise<boolean> {
  if (!eventId) return false;
  const handled = await readHandled();
  return !!handled[eventId];
}

/** iCalUids of marked events that aren't LOCALLY handled — the candidate set to
 *  ask the engine about. Deliberately ignores engineHandled: we must keep asking
 *  about already-engine-handled events so a pass cancelled elsewhere is re-detected
 *  and the event resurfaces. */
export async function listPendingICalUids(): Promise<string[]> {
  const [marked, handled] = await Promise.all([readMarked(), readHandled()]);
  const uids = new Set<string>();
  for (const m of Object.values(marked)) {
    if (handled[m.eventId]) continue;
    if (m.iCalUid) uids.add(m.iCalUid);
  }
  return [...uids];
}

/** Replace the engine-handled iCalUid set with the latest status answer. Overwrite
 *  (not merge) so events whose passes were cancelled elsewhere drop out and
 *  resurface. Lower-cased for case-insensitive matching against marked iCalUids. */
export async function setEngineHandled(iCalUids: string[]): Promise<void> {
  await chrome.storage.local.set({
    [ENGINE_HANDLED_KEY]: [...new Set(iCalUids.map((u) => u.toLowerCase()))],
  });
}

export interface SyncResult {
  changedIds: Set<string>;
  newMarked: VisitorEventSummary[];
  /** Events seen this cycle that are no longer pending visitor events (deleted/
   *  cancelled). Lets the in-page nudge purge stale optimistic guesses. */
  cancelledIds: string[];
  markedCount: number;
}

/** Coalesce concurrent syncs (the 1-minute alarm + on-demand LIST/SYNC_NOW) so
 *  they can't race on the shared sync token / marked map and lose an update — both
 *  read the same baseline, both write at the end, and the later write clobbers the
 *  earlier one (an event one run marked can vanish, and won't be re-reported once
 *  the token advances). One in-flight sync at a time removes that hazard. */
let inFlight: Promise<SyncResult> | null = null;
export function runSync(accessToken: string): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = doRunSync(accessToken).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Pull changes since the last sync; update the marked set; report deltas. */
async function doRunSync(accessToken: string): Promise<SyncResult> {
  const store = await chrome.storage.local.get([
    SYNC_TOKEN_KEY,
    MARKED_KEY,
    HANDLED_KEY,
    ENGINE_HANDLED_KEY,
    LAST_FULL_KEY,
  ]);
  const engineHandled = new Set((store[ENGINE_HANDLED_KEY] as string[]) ?? []);
  // The set we knew BEFORE this sync — the baseline for "what's genuinely new"
  // (so a full re-scan that re-discovers the whole window doesn't re-notify).
  const prevMarked = (store[MARKED_KEY] as MarkedMap) ?? {};
  const handled = (store[HANDLED_KEY] as HandledMap) ?? {};
  const lastFull = (store[LAST_FULL_KEY] as number) ?? 0;

  let syncToken = store[SYNC_TOKEN_KEY] as string | undefined;
  // Force a periodic full re-scan: incremental sync never re-reports an event
  // whose change was already consumed, so a once-missed event (wrong magic
  // address in a past build, a transient attendee trim) would stay invisible
  // forever. Dropping the token re-evaluates the whole forward window.
  if (syncToken && Date.now() - lastFull > FULL_RESYNC_INTERVAL_MS) {
    syncToken = undefined;
  }

  let resp = await listEvents(accessToken, { syncToken });
  if (resp.expired) {
    // Token stale → full resync from scratch.
    syncToken = undefined;
    resp = await listEvents(accessToken, {});
  }
  // A tokenless call re-scanned the full window; rebuild the set from scratch so
  // stale/no-longer-marked events drop out. Incremental carries the set forward.
  const fullSync = !syncToken;
  const marked: MarkedMap = fullSync ? {} : { ...prevMarked };

  const changedIds = new Set<string>();
  const newMarked: VisitorEventSummary[] = [];
  const cancelledIds: string[] = [];

  // Series we already tracked (any previously-marked instance) — so a newly
  // discovered later occurrence of a known recurring event, OR a full re-scan
  // that re-finds the whole window, doesn't fire a fresh notification.
  const knownSeries = new Set(
    Object.values(prevMarked).map((m) => m.seriesId ?? m.eventId),
  );
  // Series notified within THIS cycle — collapses an initial sync that discovers
  // dozens of weekly instances at once down to a single notification.
  const notifiedSeries = new Set<string>();

  for (const ev of resp.items) {
    if (!ev.id) continue;
    changedIds.add(ev.id);
    const cancelled = ev.status === 'cancelled';
    const hasMagic = isMarked(ev);
    // DIAGNOSTIC: the magic address is somewhere in this event's payload, yet
    // isMarked() didn't flag it — i.e. it's not a structured attendee email and
    // not in `location` (e.g. it's only in the description, or events.list
    // returned a trimmed attendee list). This is the signature of a primary-
    // calendar miss; the warning shows exactly what we got back.
    if (!hasMagic && MAGIC_ADDRESS && JSON.stringify(ev).toLowerCase().includes(MAGIC_ADDRESS)) {
      console.warn(
        '[auxilio] sync MISS: magic address in payload but isMarked() is false',
        { id: ev.id, summary: ev.summary, location: ev.location, attendees: ev.attendees, status: ev.status },
      );
    }
    // Only the event's ORGANIZER (the host) registers visitors. A guest who was
    // merely invited to a visitor event sees the magic address among the attendees
    // on THEIR copy too — but they must never be nudged/badged/notified to "manage"
    // someone else's event (the reported bug). organizer.self is Google's
    // authoritative "this calendar's user owns the event" flag.
    const marked_ = hasMagic && ev.organizer?.self === true;
    if (marked_ && !cancelled) {
      const seriesId = ev.recurringEventId || ev.id;
      const summary: VisitorEventSummary = {
        eid: encodeEid(ev.id, 'primary'),
        eventId: ev.id,
        iCalUid: ev.iCalUID ?? '',
        title: ev.summary || '(no title)',
        start: ev.start?.dateTime ?? ev.start?.date,
        seriesId,
      };
      // Notify only for a genuinely new, not-yet-handled occurrence of a series we
      // weren't already tracking — one alert per recurring series, not per
      // instance, and never for an event a full re-scan merely re-discovered.
      const newInstance = !prevMarked[ev.id] && !handled[ev.id];
      if (newInstance && !knownSeries.has(seriesId) && !notifiedSeries.has(seriesId)) {
        newMarked.push(summary);
        notifiedSeries.add(seriesId);
      }
      marked[ev.id] = summary;
    } else {
      // Cancelled (deleted) or no longer a tracked visitor event (magic removed, or
      // not organized by us) → not pending. Report it so any optimistic in-page nudge
      // for it gets purged, and drop it from the marked set.
      if (cancelled || prevMarked[ev.id]) cancelledIds.push(ev.id);
      delete marked[ev.id];
      // Only FORGET the "handled" record on a genuine cancel/delete. Don't drop it
      // just because the event left our tracked set for another reason (e.g. a
      // momentarily-absent organizer.self on one sync pass) — that would let an
      // already-sent event re-nudge through the optimistic path. The 30-day TTL
      // (handledCutoff below) prunes stale records anyway.
      if (cancelled) delete handled[ev.id];
    }
  }

  // Prune events that are well past.
  const cutoff = Date.now() - PAST_GRACE_MS;
  for (const id of Object.keys(marked)) {
    const s = marked[id].start;
    if (s && Date.parse(s) < cutoff) delete marked[id];
  }

  // Prune stale "handled" records so the overlay can't grow without bound.
  const handledCutoff = Date.now() - HANDLED_TTL_MS;
  for (const id of Object.keys(handled)) {
    if (handled[id] < handledCutoff) delete handled[id];
  }

  // DIAGNOSTIC: one line per sync so a primary-calendar miss is obvious — did the
  // list even return the event (itemsReturned), and did anything end up marked?
  console.log('[auxilio] sync done', {
    mode: fullSync ? 'full' : 'incremental',
    magicAddress: MAGIC_ADDRESS,
    itemsReturned: resp.items.length,
    markedTotal: Object.keys(marked).length,
    newMarked: newMarked.length,
  });

  await chrome.storage.local.set({
    [SYNC_TOKEN_KEY]: resp.nextSyncToken ?? syncToken,
    [MARKED_KEY]: marked,
    [HANDLED_KEY]: handled,
    // Stamp the full-resync clock only when we actually did one, so the periodic
    // re-scan fires on schedule regardless of how often incremental sync runs.
    ...(fullSync ? { [LAST_FULL_KEY]: Date.now() } : {}),
  });

  // markedCount drives the toolbar badge — count distinct pending series (a
  // recurring event counts once, not once per occurrence), excluding events the
  // engine already handled elsewhere. Uses the engineHandled set from the start
  // of this sync; the post-sync status poll reconciles the badge if it changed.
  const pendingSeries = new Set<string>();
  for (const id of Object.keys(marked)) {
    if (handled[id]) continue;
    if (engineHandled.has((marked[id].iCalUid ?? '').toLowerCase())) continue;
    pendingSeries.add(marked[id].seriesId ?? id);
  }
  return { changedIds, newMarked, cancelledIds, markedCount: pendingSeries.size };
}

/** Upcoming visitor events still needing passes, soonest first — for the panel's
 *  picker and the in-page nudge. Handled events are filtered out, and a recurring
 *  series collapses to its soonest pending occurrence (one row, not one per week). */
export async function listMarked(): Promise<VisitorEventSummary[]> {
  const [marked, handled, engineHandled] = await Promise.all([
    readMarked(),
    readHandled(),
    readEngineHandled(),
  ]);
  const bySeries = new Map<string, VisitorEventSummary>();
  for (const m of Object.values(marked)) {
    if (handled[m.eventId]) continue;
    if (engineHandled.has((m.iCalUid ?? '').toLowerCase())) continue;
    const key = m.seriesId ?? m.eventId;
    const existing = bySeries.get(key);
    if (!existing || (m.start ?? '~').localeCompare(existing.start ?? '~') < 0) {
      bySeries.set(key, m);
    }
  }
  return [...bySeries.values()].sort((a, b) =>
    (a.start ?? '').localeCompare(b.start ?? ''),
  );
}

/** Every upcoming visitor event for the side-panel homescreen — the MANAGEMENT
 *  surface. Unlike listMarked (which feeds the nag surfaces and hides handled
 *  events), this INCLUDES sent events tagged `status:'sent'` so a host can reopen
 *  one to update or cancel, and so the screen confirms finished work instead of
 *  going barren after the last send. Series-collapsed to one row: a recurring
 *  series is 'pending' if ANY occurrence in the window still needs passes (shown at
 *  its soonest pending occurrence), otherwise 'sent' (shown at its soonest). */
export async function listForPanel(): Promise<PanelVisitorEvent[]> {
  const [marked, handled, engineHandled] = await Promise.all([
    readMarked(),
    readHandled(),
    readEngineHandled(),
  ]);
  const isSent = (m: VisitorEventSummary) =>
    !!handled[m.eventId] || engineHandled.has((m.iCalUid ?? '').toLowerCase());
  const earlier = (a: VisitorEventSummary, b?: VisitorEventSummary) =>
    !b || (a.start ?? '~').localeCompare(b.start ?? '~') < 0;

  const bySeries = new Map<
    string,
    { soonestAny: VisitorEventSummary; soonestPending?: VisitorEventSummary }
  >();
  for (const m of Object.values(marked)) {
    const key = m.seriesId ?? m.eventId;
    const entry = bySeries.get(key) ?? { soonestAny: m };
    if (earlier(m, entry.soonestAny)) entry.soonestAny = m;
    if (!isSent(m) && earlier(m, entry.soonestPending)) entry.soonestPending = m;
    bySeries.set(key, entry);
  }

  const rows: PanelVisitorEvent[] = [...bySeries.values()].map((e) =>
    e.soonestPending
      ? { ...e.soonestPending, status: 'pending' }
      : { ...e.soonestAny, status: 'sent' },
  );
  return rows.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
}

/** Is this event id currently a known visitor event? */
export async function isEventMarked(eventId: string): Promise<boolean> {
  const marked = await readMarked();
  return !!marked[eventId];
}
