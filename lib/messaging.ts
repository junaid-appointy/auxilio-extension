/**
 * Typed RPC over chrome.runtime messaging. The side panel (and content script)
 * never touch tokens or the network directly — they send these messages and the
 * background worker does the work. This keeps the thin-adapter boundary: one
 * place holds secrets + network.
 */
import type {
  ActiveEvent,
  AuthStatus,
  DomEventSnapshot,
  DraftPatch,
  DraftResponse,
  PreviewResponse,
  SendResponse,
  VisitDraft,
  VisitorEventSummary,
} from './types';

export type RpcRequest =
  | { type: 'AUTH_STATUS' }
  | { type: 'AUTH_SIGN_IN' }
  | { type: 'AUTH_SIGN_OUT' }
  | { type: 'OPEN_PANEL' }
  | { type: 'OPEN_FOR_EVENT'; eid: string; snapshot?: DomEventSnapshot }
  | { type: 'FOLLOW_EVENT'; eid: string; snapshot?: DomEventSnapshot }
  | { type: 'RESOLVE_EVENT'; eid: string }
  | { type: 'DRAFT_LOAD'; event: ActiveEvent }
  | { type: 'DRAFT_PATCH'; iCalUid: string; patch: DraftPatch }
  | { type: 'PREVIEW'; iCalUid: string; visitorEmail: string }
  | { type: 'SEND'; iCalUid: string; start?: string; end?: string }
  | { type: 'CANCEL_GUEST'; iCalUid: string; invitationId: string }
  | { type: 'LIST_VISITOR_EVENTS' }
  | { type: 'GET_NUDGE_TARGETS' }
  | { type: 'SYNC_NOW' }
  | { type: 'GET_PANEL_STATE' }
  | { type: 'NAVIGATE_TO_EVENT'; eventId?: string; eid?: string };

/** Maps each request type to its success payload. */
export interface RpcResultMap {
  AUTH_STATUS: AuthStatus;
  AUTH_SIGN_IN: AuthStatus;
  AUTH_SIGN_OUT: { signedIn: false };
  OPEN_PANEL: { opened: boolean };
  OPEN_FOR_EVENT: { opened: boolean };
  FOLLOW_EVENT: { followed: boolean };
  RESOLVE_EVENT: ActiveEvent;
  DRAFT_LOAD: DraftResponse;
  DRAFT_PATCH: VisitDraft;
  PREVIEW: PreviewResponse;
  SEND: SendResponse;
  CANCEL_GUEST: { invitationId: string; cancelled: boolean };
  LIST_VISITOR_EVENTS: VisitorEventSummary[];
  GET_NUDGE_TARGETS: VisitorEventSummary[];
  SYNC_NOW: { synced: boolean };
  GET_PANEL_STATE: { open: boolean };
  NAVIGATE_TO_EVENT: { navigated: boolean };
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
 *  content-script button click, read reactively by the side panel). */
export const ACTIVE_EID_KEY = 'auxilio.activeEid';

/** storage.session key holding the DOM snapshot for the pending event — lets the
 *  panel paint instantly + handle the unsaved (no-API) case. */
export const ACTIVE_SNAPSHOT_KEY = 'auxilio.activeSnapshot';

/** Background→content broadcast of side-panel open state, so the in-page button
 *  hides while the panel is open (no redundant control). */
export const PANEL_STATE = '__auxilio_panel_state';

/** Port name the side panel connects on mount so background can track open/close. */
export const SIDEPANEL_PORT = 'auxilio.sidepanel';

/** Background→content broadcast of the visitor events needing passes (drives the
 *  in-page nudge banner). */
export const NUDGE_TARGETS = '__auxilio_nudge_targets';

/** Background→content broadcast: a recoverable auth lapse (the user was connected
 *  but a silent token renew failed). Drives the in-page "Reconnect Auxilio" banner
 *  so nudging never dies silently. `lapsed:false` clears it once renew succeeds. */
export const AUTH_LAPSED = '__auxilio_auth_lapsed';

/** One-way background→panel broadcast: the active event changed on the server
 *  (post-save), so the panel should refetch. Not an RPC (no response). */
export const REFRESH_ACTIVE = '__auxilio_refresh_active';

export function broadcastRefreshActive(): void {
  chrome.runtime.sendMessage({ type: REFRESH_ACTIVE }).catch(() => {});
}
