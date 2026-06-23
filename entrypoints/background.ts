import {
  ACTIVE_EID_KEY,
  ACTIVE_SNAPSHOT_KEY,
  AUTH_LAPSED,
  NUDGE_TARGETS,
  PANEL_STATE,
  SIDEPANEL_PORT,
  broadcastRefreshActive,
  type RpcRequest,
  type RpcResponse,
} from '@/lib/messaging';
import { authStatus, getValidTokens, signIn, signOut, wasConnected } from '@/lib/auth';
import { decodeEid, encodeEid, fetchActiveEvent } from '@/lib/calendar';
import { clearSyncToken, listMarked, markHandled, runSync } from '@/lib/calendar-sync';
import { EngineError, engine } from '@/lib/engine';
import type { VisitorEventSummary } from '@/lib/types';

const SYNC_ALARM = 'auxilio-sync';
const BADGE_COLOR = '#92288E';
// Muted/error badge for a recoverable auth lapse — visually distinct from the
// brand-tinted visitor-count badge so "nudging is offline" never reads as a count.
const LAPSED_BADGE_COLOR = '#B3261E';

// Whether the side panel is currently open (a port is connected). Content
// scripts ask for this on (re)load so auto-follow works after navigation.
let panelConnected = false;

export default defineBackground(() => {
  // Let content scripts read/write storage.session (default is trusted-only).
  // Needed for the active-event handoff + nudge-dismissal persistence.
  chrome.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch((err) => console.warn('[auxilio] setAccessLevel failed', err));

  // Toolbar icon opens the panel (Chrome's required user gesture).
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[auxilio] setPanelBehavior failed', err));

  // Durable, official change-detection: poll on an alarm (no DOM).
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
    // Re-scan from scratch on install/update: a config change (e.g. the magic
    // address) only takes effect on a full sync, since incremental never
    // re-reports an already-consumed change. clearSyncToken forces that.
    void clearSyncToken().then(() => doSync());
  });
  chrome.runtime.onStartup.addListener(() => void doSync());
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === SYNC_ALARM) void doSync();
  });
  chrome.notifications.onClicked.addListener((id) => chrome.notifications.clear(id));

  // Track the side panel open/closed via a port it connects on mount, and tell
  // calendar tabs so the in-page button can hide while the panel is open.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== SIDEPANEL_PORT) return;
    panelConnected = true;
    broadcastPanelState(true);
    port.onDisconnect.addListener(() => {
      panelConnected = false;
      broadcastPanelState(false);
    });
  });

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
    // Token unavailable. If the user was connected, this is a recoverable lapse
    // (storage.session wiped on restart, or silent renew failed) — surface it so
    // nudging never dies silently. If they never connected, stay quiet.
    if (await wasConnected()) await setLapsed(true);
    return;
  }
  let result;
  try {
    result = await runSync(accessToken);
  } catch (err) {
    console.warn('[auxilio] sync failed', err);
    return;
  }

  // Got here with working tokens → any prior lapse is over.
  await setLapsed(false);

  // Toolbar badge = number of upcoming visitor events (the on-icon nudge).
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({
    text: result.markedCount > 0 ? String(result.markedCount) : '',
  });

  // OS notification for each newly-discovered visitor event (out-of-tab alert).
  for (const ev of result.newMarked) notifyVisitorEvent(ev);

  // In-page nudge banner: push the current marked set to calendar tabs, plus
  // any events that just stopped being pending (deleted/cancelled) so the page
  // can purge stale optimistic nudges for them.
  broadcastNudge(await listMarked(), result.cancelledIds);

  // If the event the panel is showing changed (post-save), tell it to refetch.
  const stored = await chrome.storage.session.get(ACTIVE_EID_KEY);
  const activeEid = stored[ACTIVE_EID_KEY] as string | undefined;
  if (activeEid) {
    const dec = decodeEid(activeEid);
    if (dec && result.changedIds.has(dec.eventId)) broadcastRefreshActive();
  }
}

function broadcastPanelState(open: boolean): void {
  sendToCalendarTabs({ type: PANEL_STATE, open });
}

function broadcastNudge(targets: VisitorEventSummary[], cancelled: string[] = []): void {
  sendToCalendarTabs({ type: NUDGE_TARGETS, targets, cancelled });
}

/** Enter/leave the recoverable auth-lapsed state: a distinct toolbar badge plus a
 *  broadcast that drives the in-page "Reconnect" banner. Broadcast unconditionally
 *  so a calendar tab loaded mid-lapse learns about it on the next sync. */
async function setLapsed(lapsed: boolean): Promise<void> {
  if (lapsed) {
    await chrome.action.setBadgeBackgroundColor({ color: LAPSED_BADGE_COLOR });
    await chrome.action.setBadgeText({ text: '!' });
  }
  sendToCalendarTabs({ type: AUTH_LAPSED, lapsed });
}

/** Recompute the nudge surfaces from local state (no Calendar round-trip) — used
 *  after a send marks an event handled, so the badge/banner drop it immediately. */
async function refreshNudgeSurfaces(): Promise<void> {
  const targets = await listMarked();
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: targets.length > 0 ? String(targets.length) : '' });
  broadcastNudge(targets);
}

function sendToCalendarTabs(message: unknown): void {
  chrome.tabs
    .query({ url: 'https://calendar.google.com/*' })
    .then((tabs) => {
      for (const t of tabs) {
        if (t.id != null) chrome.tabs.sendMessage(t.id, message).catch(() => {});
      }
    })
    .catch(() => {});
}

function notifyVisitorEvent(ev: VisitorEventSummary): void {
  chrome.notifications.create(`auxilio:${ev.eventId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon/128.png'),
    title: 'Visitor event',
    message: `${ev.title}. Open Auxilio to register passes.`,
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
  fn: (t: { idToken: string; accessToken: string; email?: string }) => Promise<T>,
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

    case 'OPEN_PANEL': {
      // Open the side panel within the in-page click's user activation (e.g. the
      // "Reconnect" banner) so the user lands on the sign-in gate. No active event.
      const tabId = sender.tab?.id;
      let opened = false;
      if (!panelConnected && tabId != null) {
        try {
          await chrome.sidePanel.open({ tabId });
          opened = true;
        } catch (err) {
          console.warn('[auxilio] sidePanel.open failed (gesture not carried?)', err);
        }
      }
      return ok({ opened });
    }

    case 'OPEN_FOR_EVENT': {
      // The background is the single authority on open-vs-follow: panelConnected
      // (the panel's own port) is the truth, so the content script no longer
      // guesses with local flags that drift. Open the panel only when it isn't
      // already connected — otherwise this is just a "follow" and we fall through
      // to update the active event below. Call sidePanel.open FIRST, before any
      // await, so the content-script click's user activation is still valid
      // (sidePanel.open requires a live gesture).
      const tabId = sender.tab?.id;
      let opened = false;
      if (!panelConnected && tabId != null) {
        try {
          await chrome.sidePanel.open({ tabId });
          opened = true;
        } catch (err) {
          console.warn('[auxilio] sidePanel.open failed (gesture not carried?)', err);
        }
      }
      // Store after — the panel reacts to this via storage.onChanged either way.
      // The DOM snapshot lets the panel paint instantly + cover the unsaved case.
      await chrome.storage.session.set({
        [ACTIVE_EID_KEY]: msg.eid,
        [ACTIVE_SNAPSHOT_KEY]: msg.snapshot ?? null,
      });
      return ok({ opened });
    }

    case 'FOLLOW_EVENT': {
      // Auto-follow: point the (already open) panel at the event the user is
      // viewing — no sidePanel.open. The panel applies its own busy-guard.
      await chrome.storage.session.set({
        [ACTIVE_EID_KEY]: msg.eid,
        [ACTIVE_SNAPSHOT_KEY]: msg.snapshot ?? null,
      });
      return ok({ followed: true });
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
      return withTokens(async (t) => {
        const result = await engine.send(t.idToken, msg.iCalUid, msg.start, msg.end);
        // Passes are now issued (or remain issued after an update) → drop this
        // event from the nudge surfaces. Keyed by the event id the sync tracks
        // (providerEventId), so the badge/banner stop nagging immediately.
        if (result.activeCount > 0 && result.draft.providerEventId) {
          await markHandled(result.draft.providerEventId);
          await refreshNudgeSurfaces();
        }
        return result;
      });
    case 'CANCEL_GUEST':
      return withIdToken((t) =>
        engine.cancelGuest(t, msg.iCalUid, msg.invitationId),
      );

    case 'LIST_VISITOR_EVENTS':
      return withTokens(async (t) => {
        // A refresh hiccup (a transient Calendar API error) must not blank the
        // list — serve the last-known marked set instead of failing the query.
        try {
          await runSync(t.accessToken); // refresh before listing
        } catch (err) {
          console.warn('[auxilio] LIST_VISITOR_EVENTS refresh failed; serving cached set', err);
        }
        return listMarked();
      });

    case 'GET_NUDGE_TARGETS':
      // Cheap read of the last-synced marked set (no token / no sync) — lets the
      // content script seed its banner immediately on page load.
      return ok(await listMarked());

    case 'SYNC_NOW':
      // On-demand sync (page load / tab focus / just left the editor) so the
      // banner appears fast instead of waiting up to a minute for the alarm.
      await doSync();
      return ok({ synced: true });

    case 'GET_PANEL_STATE':
      return ok({ open: panelConnected });

    case 'NAVIGATE_TO_EVENT':
      return withTokens(async (t) => {
        // Open the event's full EDIT screen (/r/eventedit/<eid>) in the existing
        // calendar tab — same tab, no new tab. The button passes a ready eid
        // (from the page's data-eventid); the nudge passes eventId to encode
        // (sync events only carry the id; primary calendar id = the user's email).
        let editEid = msg.eid;
        if (!editEid && msg.eventId) {
          const email = t.email ?? (await authStatus()).email ?? 'primary';
          editEid = encodeEid(msg.eventId, email);
        }
        // The web editor needs the *real* calendar id in the eid — for the
        // primary calendar that's the user's email, not the literal "primary"
        // (which the Calendar API accepts but the /eventedit URL can't resolve).
        // Sync/nudge eids are encoded with "primary", so rewrite them here.
        if (editEid) {
          const dec = decodeEid(editEid);
          if (dec && (dec.calendarId === 'primary' || !dec.calendarId)) {
            const email = t.email ?? (await authStatus()).email;
            if (email) editEid = encodeEid(dec.eventId, email);
          }
        }
        // Google's eventedit eid is base64 with padding stripped — normalize the
        // raw data-eventid (which may carry `=` padding) to match.
        if (editEid) editEid = editEid.replace(/=+$/, '');
        if (!editEid) return { navigated: false };
        const tabs = await chrome.tabs.query({ url: 'https://calendar.google.com/*' });
        const tab = tabs.find((x) => x.active) ?? tabs[0];
        if (tab?.id == null || !tab.url) return { navigated: false };
        // Build the edit-screen URL from the /u/<n>/ account segment.
        const u = tab.url.match(/\/calendar\/(u\/\d+\/)?/);
        const userSeg = u?.[1] ?? '';
        const url = `https://calendar.google.com/calendar/${userSeg}r/eventedit/${editEid}`;
        console.log('[auxilio] navigate →', { from: tab.url, to: url, editEid });
        await chrome.tabs.update(tab.id, { url, active: true });
        return { navigated: true };
      });

    default:
      return { ok: false, error: 'Unknown request' };
  }
}
