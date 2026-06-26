/**
 * Calendar read (background only). Two jobs:
 *  1) resolve the canonical event for a given eid (events.get) — authoritative
 *     iCalUID + attendees for the side panel.
 *  2) list changes via a sync token (events.list) — the durable "what changed"
 *     API that drives post-save refresh + the visitor-event nudge/badge.
 * Calendar.events.readonly only.
 */
import { MAGIC_ADDRESS } from './config';
import type { ActiveEvent } from './types';

/** Forward window for the change-feed scan. `singleEvents=true` expands EVERY
 *  recurring series into per-occurrence instances; with no bound a daily event
 *  alone yields ~700 rows and a busy calendar returns 6000+ — a ~14s, 25-page
 *  scan that the MV3 worker can be killed in the middle of (leaving the marked
 *  set stale). Visitor nudges are near-term, so we cap the window: ~90 days cuts
 *  that to a few hundred rows / ~2s. The periodic full re-scan slides it forward. */
const FORWARD_WINDOW_MS = 90 * 24 * 60 * 60_000;

/** `eid` is URL-safe base64 of "<eventId> <calendarId>" (calendarId optional). */
export function decodeEid(eid: string): { eventId: string; calendarId: string } | null {
  try {
    let b64 = eid.replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = atob(b64);
    const [eventId, calendarId] = decoded.split(' ');
    if (!eventId) return null;
    return { eventId, calendarId: calendarId || 'primary' };
  } catch {
    return null;
  }
}

/** Inverse of decodeEid — build an eid the side panel can resolve. */
export function encodeEid(eventId: string, calendarId = 'primary'): string {
  const b64 = btoa(`${eventId} ${calendarId}`);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface GCalEvent {
  id?: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  /** Present on instances of a recurring series (with singleEvents=true): the id
   *  of the parent series. Lets us treat a series as one nudge unit. */
  recurringEventId?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: {
    email?: string;
    displayName?: string;
    resource?: boolean;
    self?: boolean;
    organizer?: boolean;
  }[];
}

/** Is this a visitor event? (magic address among attendees or in the location.) */
export function isMarked(ev: GCalEvent): boolean {
  if (!MAGIC_ADDRESS) return false;
  const inAttendees = (ev.attendees ?? []).some(
    (a) => a.email?.toLowerCase() === MAGIC_ADDRESS,
  );
  const inLocation = (ev.location ?? '').toLowerCase().includes(MAGIC_ADDRESS);
  return inAttendees || inLocation;
}

function startOf(ev: GCalEvent): string | undefined {
  return ev.start?.dateTime ?? ev.start?.date;
}

async function getEvent(
  calendarId: string,
  eventId: string,
  accessToken: string,
): Promise<Response> {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId,
    )}/events/${encodeURIComponent(eventId)}`,
  );
  url.searchParams.set(
    'fields',
    'iCalUID,summary,location,description,start,end,organizer,attendees(email,displayName,resource,self,organizer)',
  );
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

export async function fetchActiveEvent(
  eid: string,
  accessToken: string,
): Promise<ActiveEvent> {
  const dec = decodeEid(eid);
  if (!dec) throw new Error('Could not read the event id from this page.');

  // Recurring chips carry an instance id ("<base>_<ts>"); events.get often 404s
  // on the instance, so also try the base id. And try `primary` in case the
  // decoded calendar id isn't directly fetchable.
  const baseId = dec.eventId.includes('_') ? dec.eventId.split('_')[0] : null;
  const candidates: { cal: string; id: string }[] = [
    { cal: dec.calendarId, id: dec.eventId },
    ...(dec.calendarId !== 'primary' ? [{ cal: 'primary', id: dec.eventId }] : []),
    ...(baseId ? [{ cal: dec.calendarId, id: baseId }] : []),
    ...(baseId && dec.calendarId !== 'primary' ? [{ cal: 'primary', id: baseId }] : []),
  ];
  console.log('[auxilio] resolve event', { eid, ...dec, candidates });

  let res: Response | null = null;
  let lastStatus = 0;
  let lastBody = '';
  for (const c of candidates) {
    const r = await getEvent(c.cal, c.id, accessToken);
    if (r.ok) {
      res = r;
      break;
    }
    lastStatus = r.status;
    lastBody = await r.text().catch(() => '');
    console.warn('[auxilio] events.get miss', c, r.status, lastBody.slice(0, 200));
  }

  if (!res) {
    console.warn('[auxilio] resolve 404', { ...dec, lastBody: lastBody.slice(0, 200) });
    if (lastStatus === 404) {
      // Most common cause: a brand-new event that hasn't been saved yet — it
      // doesn't exist on Google's servers, so there's nothing to fetch.
      throw new Error('NOT_SAVED');
    }
    throw new Error(`Calendar API error (${lastStatus}). ${lastBody.slice(0, 120)}`);
  }
  const ev = (await res.json()) as GCalEvent;
  console.log('[auxilio] resolved event', {
    iCalUID: ev.iCalUID,
    summary: ev.summary,
    attendees: ev.attendees?.length ?? 0,
  });

  const attendees = (ev.attendees ?? [])
    .filter((a) => a.email && !a.resource && a.email.toLowerCase() !== MAGIC_ADDRESS)
    .map((a) => ({ email: a.email as string, name: a.displayName }));

  const rooms = (ev.attendees ?? [])
    .filter((a) => a.resource)
    .map((a) => a.displayName || a.email || '')
    .filter(Boolean);

  return {
    iCalUid: ev.iCalUID ?? '',
    providerEventId: dec.eventId,
    title: ev.summary,
    start: startOf(ev),
    end: ev.end?.dateTime ?? ev.end?.date,
    location: ev.location,
    description: ev.description,
    rooms,
    organizerEmail: ev.organizer?.email,
    attendees,
  };
}

/**
 * List changes on the primary calendar. With a sync token → only what changed
 * since last sync; without → an initial window of upcoming events (and a fresh
 * token). Paginates to capture nextSyncToken. Returns expired:true on a 410 so
 * the caller can full-resync.
 *
 * KNOWN LIMITATION (deferred by decision): primary calendar only. A visitor event
 * a host creates on a *secondary* calendar they own gets no sync-driven nudge
 * (badge/notification/banner) — the optimistic DOM path still fires if they open
 * it. Covering owned secondaries needs the calendar.calendarlist.readonly scope
 * (to discover them via calendarList.list) plus a per-calendar sync token. We
 * deferred this: the gap is unobserved and the extra scope/poll cost isn't worth
 * a maybe. Revisit only on a real report of a missed secondary-calendar event,
 * and when doing so, hard-filter to accessRole=owner (never poll subscribed/
 * holiday calendars).
 */
export async function listEvents(
  accessToken: string,
  opts: { syncToken?: string } = {},
): Promise<{ items: GCalEvent[]; nextSyncToken?: string; expired?: boolean }> {
  const items: GCalEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const url = new URL(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    );
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('showDeleted', 'true');
    url.searchParams.set('maxResults', '250');
    url.searchParams.set(
      'fields',
      'items(id,iCalUID,status,summary,location,recurringEventId,start,end,attendees(email,resource)),nextPageToken,nextSyncToken',
    );
    if (opts.syncToken) {
      url.searchParams.set('syncToken', opts.syncToken);
    } else {
      // Initial/full sync: a BOUNDED forward window keeps the token small and the
      // scan fast. timeMin/timeMax can't be combined with a syncToken (Google
      // rejects it), so we only set them here; the token then preserves this
      // window for subsequent incremental syncs. A fresh full re-scan (12h timer)
      // re-establishes it against the new `now`, sliding the window forward.
      const now = Date.now();
      url.searchParams.set('timeMin', new Date(now).toISOString());
      url.searchParams.set('timeMax', new Date(now + FORWARD_WINDOW_MS).toISOString());
    }
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 410) return { items: [], expired: true }; // sync token stale
    if (!res.ok) throw new Error(`Calendar list error (${res.status}).`);
    const data = (await res.json()) as {
      items?: GCalEvent[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    if (data.items) items.push(...data.items);
    pageToken = data.nextPageToken;
    nextSyncToken = data.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  return { items, nextSyncToken };
}
