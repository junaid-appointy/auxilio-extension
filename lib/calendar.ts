/**
 * Calendar read (background only). Decodes the Google Calendar `eid` from the
 * page URL and fetches the canonical event via the Calendar API so we work from
 * authoritative iCalUID + attendees (not scraped DOM). Calendar.events.readonly.
 */
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

interface GCalEvent {
  iCalUID?: string;
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
    if (res.status === 404) {
      throw new Error('This event was not found on your calendar.');
    }
    throw new Error(`Calendar API error (${res.status}).`);
  }
  const ev = (await res.json()) as GCalEvent;

  const attendees = (ev.attendees ?? [])
    .filter((a) => a.email && !a.resource)
    .map((a) => ({ email: a.email as string, name: a.displayName }));

  return {
    iCalUid: ev.iCalUID ?? '',
    providerEventId: dec.eventId,
    title: ev.summary,
    start: ev.start?.dateTime ?? ev.start?.date,
    end: ev.end?.dateTime ?? ev.end?.date,
    location: ev.location,
    organizerEmail: ev.organizer?.email,
    attendees,
  };
}
