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
import { encodeEid, isMarked, listEvents } from './calendar';
import type { VisitorEventSummary } from './types';

const SYNC_TOKEN_KEY = 'auxilio.syncToken';
const MARKED_KEY = 'auxilio.markedEvents';
const PAST_GRACE_MS = 60 * 60_000; // keep events until 1h after they end

type MarkedMap = Record<string, VisitorEventSummary>;

async function readMarked(): Promise<MarkedMap> {
  const r = await chrome.storage.local.get(MARKED_KEY);
  return (r[MARKED_KEY] as MarkedMap) ?? {};
}

export interface SyncResult {
  changedIds: Set<string>;
  newMarked: VisitorEventSummary[];
  markedCount: number;
}

/** Pull changes since the last sync; update the marked set; report deltas. */
export async function runSync(accessToken: string): Promise<SyncResult> {
  const store = await chrome.storage.local.get([SYNC_TOKEN_KEY, MARKED_KEY]);
  let syncToken = store[SYNC_TOKEN_KEY] as string | undefined;
  let marked = (store[MARKED_KEY] as MarkedMap) ?? {};

  let resp = await listEvents(accessToken, { syncToken });
  if (resp.expired) {
    // Token stale → full resync from scratch.
    syncToken = undefined;
    marked = {};
    resp = await listEvents(accessToken, {});
  }

  const changedIds = new Set<string>();
  const newMarked: VisitorEventSummary[] = [];

  for (const ev of resp.items) {
    if (!ev.id) continue;
    changedIds.add(ev.id);
    const cancelled = ev.status === 'cancelled';
    if (isMarked(ev) && !cancelled) {
      const summary: VisitorEventSummary = {
        eid: encodeEid(ev.id, 'primary'),
        eventId: ev.id,
        iCalUid: ev.iCalUID ?? '',
        title: ev.summary || '(no title)',
        start: ev.start?.dateTime ?? ev.start?.date,
      };
      if (!marked[ev.id]) newMarked.push(summary);
      marked[ev.id] = summary;
    } else {
      delete marked[ev.id]; // unmarked or cancelled
    }
  }

  // Prune events that are well past.
  const cutoff = Date.now() - PAST_GRACE_MS;
  for (const id of Object.keys(marked)) {
    const s = marked[id].start;
    if (s && Date.parse(s) < cutoff) delete marked[id];
  }

  await chrome.storage.local.set({
    [SYNC_TOKEN_KEY]: resp.nextSyncToken ?? syncToken,
    [MARKED_KEY]: marked,
  });

  return { changedIds, newMarked, markedCount: Object.keys(marked).length };
}

/** Upcoming visitor events, soonest first — for the panel's picker. */
export async function listMarked(): Promise<VisitorEventSummary[]> {
  const marked = await readMarked();
  return Object.values(marked).sort((a, b) =>
    (a.start ?? '').localeCompare(b.start ?? ''),
  );
}

/** Is this event id currently a known visitor event? */
export async function isEventMarked(eventId: string): Promise<boolean> {
  const marked = await readMarked();
  return !!marked[eventId];
}
