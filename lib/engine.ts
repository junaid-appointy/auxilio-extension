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
  const url = `${ADDON_API}/${path}`;
  const started = Date.now();
  // Abort hung requests so the UI errors instead of spinning forever
  // (bifrost dev cold-starts + MV3 service-worker lifetime can stall a fetch).
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 20_000);
  console.log('[auxilio] engine →', method, url);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new EngineError(
        `Engine did not respond within 20s (${url}). Is it reachable?`,
        0,
      );
    }
    throw new EngineError(
      `Could not reach the engine (${(err as Error).message}). Check WXT_ENGINE_URL / host_permissions.`,
      0,
    );
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  console.log('[auxilio] engine ←', res.status, `${Date.now() - started}ms`, text.slice(0, 200));
  let data: { error?: string } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) throw new EngineError(`Engine error ${res.status}: ${text.slice(0, 140)}`, res.status);
  }
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

  /** Read-only batch check: which of these events already have an active pass
   *  (through any surface). Lets the background poll suppress cross-channel nudges.
   *  Side-effect-free on the engine — safe to poll. */
  status: (idToken: string, iCalUids: string[]) =>
    call<{ active: string[] }>('status', 'POST', idToken, { iCalUids }),

  cancelGuest: (idToken: string, iCalUid: string, invitationId: string) =>
    call<{ invitationId: string; cancelled: boolean }>(
      'cancel-guest',
      'POST',
      idToken,
      { iCalUid, invitationId },
    ),

  connectCalendar: (idToken: string, code: string, redirectUri: string) =>
    call<{ connected: boolean }>('connect-calendar', 'POST', idToken, { code, redirectUri }),
};
