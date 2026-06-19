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

export async function fetchActiveEvent(
  eid: string,
  accessToken: string,
): Promise<ActiveEvent> {
  const dec = decodeEid(eid);
  if (!dec) throw new Error('Could not read the event id from this page.');

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      dec.calendarId,
    )}/events/${encodeURIComponent(dec.eventId)}`,
  );
  url.searchParams.set(
    'fields',
    'iCalUID,summary,location,start,end,organizer,attendees(email,displayName,resource,self,organizer)',
  );

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    if (res.status === 404) throw new Error('This event was not found on your calendar.');
    throw new Error(`Calendar API error (${res.status}).`);
  }
  const ev = (await res.json()) as GCalEvent;

  const attendees = (ev.attendees ?? [])
    .filter((a) => a.email && !a.resource && a.email.toLowerCase() !== MAGIC_ADDRESS)
    .map((a) => ({ email: a.email as string, name: a.displayName }));

  return {
    iCalUid: ev.iCalUID ?? '',
    providerEventId: dec.eventId,
    title: ev.summary,
    start: startOf(ev),
    end: ev.end?.dateTime ?? ev.end?.date,
    location: ev.location,
    organizerEmail: ev.organizer?.email,
    attendees,
  };
}

/**
 * List changes on the primary calendar. With a sync token → only what changed
 * since last sync; without → an initial window of upcoming events (and a fresh
 * token). Paginates to capture nextSyncToken. Returns expired:true on a 410 so
 * the caller can full-resync.
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
      'items(id,iCalUID,status,summary,location,start,end,attendees(email,resource)),nextPageToken,nextSyncToken',
    );
    if (opts.syncToken) {
      url.searchParams.set('syncToken', opts.syncToken);
    } else {
      // Initial sync: a forward window keeps the token small and relevant.
      url.searchParams.set('timeMin', new Date().toISOString());
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
