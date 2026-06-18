/**
 * Typed RPC over chrome.runtime messaging. The side panel (and content script)
 * never touch tokens or the network directly — they send these messages and the
 * background worker does the work. This keeps the thin-adapter boundary: one
 * place holds secrets + network.
 */
import type {
  ActiveEvent,
  AuthStatus,
  DraftPatch,
  DraftResponse,
  PreviewResponse,
  SendResponse,
  VisitDraft,
} from './types';

export type RpcRequest =
  | { type: 'AUTH_STATUS' }
  | { type: 'AUTH_SIGN_IN' }
  | { type: 'AUTH_SIGN_OUT' }
  | { type: 'OPEN_FOR_EVENT'; eid: string }
  | { type: 'RESOLVE_EVENT'; eid: string }
  | { type: 'DRAFT_LOAD'; event: ActiveEvent }
  | { type: 'DRAFT_PATCH'; iCalUid: string; patch: DraftPatch }
  | { type: 'PREVIEW'; iCalUid: string; visitorEmail: string }
  | { type: 'SEND'; iCalUid: string; start?: string; end?: string }
  | { type: 'CANCEL_GUEST'; iCalUid: string; invitationId: string }
  | { type: 'SET_BADGE'; marked: boolean };

/** Maps each request type to its success payload. */
export interface RpcResultMap {
  AUTH_STATUS: AuthStatus;
  AUTH_SIGN_IN: AuthStatus;
  AUTH_SIGN_OUT: { signedIn: false };
  OPEN_FOR_EVENT: { opened: boolean };
  RESOLVE_EVENT: ActiveEvent;
  DRAFT_LOAD: DraftResponse;
  DRAFT_PATCH: VisitDraft;
  PREVIEW: PreviewResponse;
  SEND: SendResponse;
  CANCEL_GUEST: { invitationId: string; cancelled: boolean };
  SET_BADGE: { done: true };
}

export type RpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number; needsAuth?: boolean };

export class RpcError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly needsAuth?: boolean,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Side-panel-side caller: throws RpcError on failure, returns typed data. */
export async function rpc<K extends RpcRequest['type']>(
  msg: Extract<RpcRequest, { type: K }>,
): Promise<RpcResultMap[K]> {
  const res = (await chrome.runtime.sendMessage(msg)) as
    | RpcResponse<RpcResultMap[K]>
    | undefined;
  if (!res) throw new RpcError('No response from background worker');
  if (!res.ok) throw new RpcError(res.error, res.status, res.needsAuth);
  return res.data;
}

/** storage.session key holding the pending event id (set by background on the
 *  content-script "Register" click, read reactively by the side panel). */
export const ACTIVE_EID_KEY = 'auxilio.activeEid';

/** One-way content→panel signal: the open event's guest list changed, so the
 *  panel should refetch. Not an RPC (no response); background ignores it. */
export const EVENT_TOUCHED = '__auxilio_event_touched';

export function notifyEventTouched(eid: string): void {
  chrome.runtime.sendMessage({ type: EVENT_TOUCHED, eid }).catch(() => {});
}
