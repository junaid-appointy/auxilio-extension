import {
  ACTIVE_EID_KEY,
  type RpcRequest,
  type RpcResponse,
} from '@/lib/messaging';
import { authStatus, getValidTokens, signIn, signOut } from '@/lib/auth';
import { fetchActiveEvent } from '@/lib/calendar';
import { EngineError, engine } from '@/lib/engine';

export default defineBackground(() => {
  // Toolbar icon opens the panel (Chrome's required user gesture).
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[auxilio] setPanelBehavior failed', err));

  chrome.runtime.onMessage.addListener((msg: RpcRequest, sender, sendResponse) => {
    // Ignore one-way broadcasts (e.g. EVENT_TOUCHED) — the panel handles those.
    if (typeof msg?.type === 'string' && msg.type.startsWith('__')) return false;
    handle(msg, sender)
      .then(sendResponse)
      .catch((err) => sendResponse(fail(err)));
    return true; // async response
  });

  console.log('[auxilio] background ready');
});

const ok = <T,>(data: T): RpcResponse<T> => ({ ok: true, data });

function fail(err: unknown): RpcResponse<never> {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof EngineError ? err.status : undefined;
  const needsAuth = status === 401;
  return { ok: false, error: message, status, needsAuth };
}

/** Run an engine call with a fresh id_token; map auth failures to needsAuth. */
async function withIdToken<T>(
  fn: (idToken: string) => Promise<T>,
): Promise<RpcResponse<T>> {
  let idToken: string;
  try {
    idToken = (await getValidTokens()).idToken;
  } catch {
    return { ok: false, error: 'Sign in to continue.', needsAuth: true };
  }
  try {
    return ok(await fn(idToken));
  } catch (err) {
    return fail(err);
  }
}

async function handle(
  msg: RpcRequest,
  sender: chrome.runtime.MessageSender,
): Promise<RpcResponse<unknown>> {
  switch (msg.type) {
    case 'AUTH_STATUS':
      return ok(await authStatus());
    case 'AUTH_SIGN_IN':
      return ok(await signIn());
    case 'AUTH_SIGN_OUT':
      await signOut();
      return ok({ signedIn: false });

    case 'OPEN_FOR_EVENT': {
      // Store the pending event id, then open the panel using the gesture that
      // came with this content-script click. Resolution/auth happens in the panel.
      await chrome.storage.session.set({ [ACTIVE_EID_KEY]: msg.eid });
      let opened = false;
      try {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          await chrome.sidePanel.open({ tabId });
          opened = true;
        }
      } catch {
        // Gesture may not have carried; the user can click the toolbar icon.
      }
      return ok({ opened });
    }

    case 'RESOLVE_EVENT':
      return withIdToken(async () => {
        const tokens = await getValidTokens();
        return fetchActiveEvent(msg.eid, tokens.accessToken);
      });

    case 'DRAFT_LOAD':
      return withIdToken((t) => engine.loadDraft(t, msg.event));
    case 'DRAFT_PATCH':
      return withIdToken((t) => engine.patchDraft(t, msg.iCalUid, msg.patch));
    case 'PREVIEW':
      return withIdToken((t) => engine.preview(t, msg.iCalUid, msg.visitorEmail));
    case 'SEND':
      return withIdToken((t) => engine.send(t, msg.iCalUid, msg.start, msg.end));
    case 'CANCEL_GUEST':
      return withIdToken((t) =>
        engine.cancelGuest(t, msg.iCalUid, msg.invitationId),
      );

    case 'SET_BADGE': {
      // Reinforce the nudge on the toolbar icon for marked (visitor) events —
      // the one thing the Calendar add-on structurally can't do.
      const tabId = sender.tab?.id;
      if (tabId != null) {
        await chrome.action.setBadgeBackgroundColor({ tabId, color: '#92288E' });
        await chrome.action.setBadgeText({ tabId, text: msg.marked ? '1' : '' });
      }
      return ok({ done: true as const });
    }

    default:
      return { ok: false, error: 'Unknown request' };
  }
}
