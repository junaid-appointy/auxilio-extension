import {
  ACTIVE_EID_KEY,
  broadcastRefreshActive,
  type RpcRequest,
  type RpcResponse,
} from '@/lib/messaging';
import { authStatus, getValidTokens, signIn, signOut } from '@/lib/auth';
import { decodeEid, fetchActiveEvent } from '@/lib/calendar';
import { listMarked, runSync } from '@/lib/calendar-sync';
import { EngineError, engine } from '@/lib/engine';
import type { VisitorEventSummary } from '@/lib/types';

const SYNC_ALARM = 'auxilio-sync';
const BADGE_COLOR = '#92288E';

export default defineBackground(() => {
  // Toolbar icon opens the panel (Chrome's required user gesture).
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[auxilio] setPanelBehavior failed', err));

  // Durable, official change-detection: poll on an alarm (no DOM).
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  chrome.runtime.onInstalled.addListener(() =>
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 }),
  );
  chrome.runtime.onStartup.addListener(() => void doSync());
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === SYNC_ALARM) void doSync();
  });
  chrome.notifications.onClicked.addListener((id) => chrome.notifications.clear(id));

  chrome.runtime.onMessage.addListener((msg: RpcRequest, sender, sendResponse) => {
    if (typeof msg?.type === 'string' && msg.type.startsWith('__')) return false; // broadcasts
    handle(msg, sender)
      .then(sendResponse)
      .catch((err) => sendResponse(fail(err)));
    return true; // async response
  });

  console.log('[auxilio] background ready');
});

// ─────────────────────────── sync loop ───────────────────────────

async function doSync(): Promise<void> {
  let accessToken: string;
  try {
    accessToken = (await getValidTokens()).accessToken;
  } catch {
    return; // not signed in — nothing to poll
  }
  let result;
  try {
    result = await runSync(accessToken);
  } catch (err) {
    console.warn('[auxilio] sync failed', err);
    return;
  }

  // Toolbar badge = number of upcoming visitor events (the on-icon nudge).
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({
    text: result.markedCount > 0 ? String(result.markedCount) : '',
  });

  // OS notification for each newly-discovered visitor event.
  for (const ev of result.newMarked) notifyVisitorEvent(ev);

  // If the event the panel is showing changed (post-save), tell it to refetch.
  const stored = await chrome.storage.session.get(ACTIVE_EID_KEY);
  const activeEid = stored[ACTIVE_EID_KEY] as string | undefined;
  if (activeEid) {
    const dec = decodeEid(activeEid);
    if (dec && result.changedIds.has(dec.eventId)) broadcastRefreshActive();
  }
}

function notifyVisitorEvent(ev: VisitorEventSummary): void {
  chrome.notifications.create(`auxilio:${ev.eventId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon/128.png'),
    title: 'Visitor event',
    message: `${ev.title} — open Auxilio to register passes`,
    priority: 1,
  });
}

// ─────────────────────────── RPC plumbing ───────────────────────────

const ok = <T,>(data: T): RpcResponse<T> => ({ ok: true, data });

function fail(err: unknown): RpcResponse<never> {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof EngineError ? err.status : undefined;
  return { ok: false, error: message, status, needsAuth: status === 401 };
}

async function withTokens<T>(
  fn: (t: { idToken: string; accessToken: string }) => Promise<T>,
): Promise<RpcResponse<T>> {
  let tokens;
  try {
    tokens = await getValidTokens();
  } catch {
    return { ok: false, error: 'Sign in to continue.', needsAuth: true };
  }
  try {
    return ok(await fn(tokens));
  } catch (err) {
    return fail(err);
  }
}

const withIdToken = <T,>(fn: (idToken: string) => Promise<T>) =>
  withTokens((t) => fn(t.idToken));

async function handle(
  msg: RpcRequest,
  sender: chrome.runtime.MessageSender,
): Promise<RpcResponse<unknown>> {
  switch (msg.type) {
    case 'AUTH_STATUS':
      return ok(await authStatus());
    case 'AUTH_SIGN_IN': {
      const status = await signIn();
      void doSync(); // warm the marked set + badge right after sign-in
      return ok(status);
    }
    case 'AUTH_SIGN_OUT':
      await signOut();
      await chrome.action.setBadgeText({ text: '' });
      return ok({ signedIn: false });

    case 'OPEN_FOR_EVENT': {
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
      return withTokens((t) => fetchActiveEvent(msg.eid, t.accessToken));

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

    case 'LIST_VISITOR_EVENTS':
      return withTokens(async (t) => {
        await runSync(t.accessToken); // refresh before listing
        return listMarked();
      });

    default:
      return { ok: false, error: 'Unknown request' };
  }
}
