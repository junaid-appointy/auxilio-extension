/**
 * Engine client (background only) for the office-ops-engine /addon/* routes.
 * Reuses the existing contract verbatim — no engine changes. Authenticated with
 * the host's Google id_token (Bearer). Always sends the canonical iCalUid so the
 * extension converges on the same calendar_event_links row as .ics/OAuth/add-on.
 */
import { ADDON_API } from './config';
import type {
  ActiveEvent,
  DraftPatch,
  DraftResponse,
  PreviewResponse,
  SendResponse,
  VisitDraft,
} from './types';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

async function call<T>(
  path: string,
  method: string,
  idToken: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${ADDON_API}/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new EngineError(data?.error ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export const engine = {
  loadDraft: (idToken: string, ev: ActiveEvent) =>
    call<DraftResponse>('draft', 'POST', idToken, {
      iCalUid: ev.iCalUid,
      providerEventId: ev.providerEventId,
      title: ev.title,
      attendees: ev.attendees,
      start: ev.start,
      end: ev.end,
      location: ev.location,
      organizerEmail: ev.organizerEmail,
    }),

  patchDraft: (idToken: string, iCalUid: string, patch: DraftPatch) =>
    call<VisitDraft>('draft', 'PATCH', idToken, { iCalUid, patch }),

  preview: (idToken: string, iCalUid: string, visitorEmail: string) =>
    call<PreviewResponse>('preview', 'POST', idToken, { iCalUid, visitorEmail }),

  send: (idToken: string, iCalUid: string, start?: string, end?: string) =>
    call<SendResponse>('send', 'POST', idToken, { iCalUid, start, end }),

  cancelGuest: (idToken: string, iCalUid: string, invitationId: string) =>
    call<{ invitationId: string; cancelled: boolean }>(
      'cancel-guest',
      'POST',
      idToken,
      { iCalUid, invitationId },
    ),
};
