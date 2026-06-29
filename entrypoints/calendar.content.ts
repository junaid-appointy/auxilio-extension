/**
 * Content script on Google Calendar — the DOM layer of the hybrid model.
 *
 * It reads the open event surface (detail popover / expanded edit) to:
 *  - GATE the "Manage Visitors" button on the magic address being a guest,
 *  - capture the `data-eventid` (base64url "<eventId> <calendarId>"), and
 *  - take a best-effort SNAPSHOT (guest emails) so the panel can paint instantly
 *    and cover the unsaved (no-API) case.
 * The API layer (background) remains the authoritative source. We read only the
 * semantic `data-eventid`, the `[role="dialog"]` ARIA signal, and the surface's
 * visible text — no layout/CSS-class coupling, no injection into Google's markup.
 */
import { MAGIC_ADDRESS } from '@/lib/config';
import {
  ACTIVE_EID_KEY,
  ACTIVE_SNAPSHOT_KEY,
  AUTH_LAPSED,
  NUDGE_TARGETS,
  PANEL_STATE,
} from '@/lib/messaging';
import type { DomEventSnapshot, VisitorEventSummary } from '@/lib/types';

/** True while our extension context is still valid. After an extension reload or
 *  update, this content script is orphaned: every `chrome.*` call then throws
 *  "Extension context invalidated" (synchronously — `.catch()` can't see it). We
 *  check this before touching any chrome API so an orphan stops quietly. */
const extAlive = (): boolean => {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
};

/** sendMessage that never throws or rejects, even once the context is gone. */
function safeSend<T = unknown>(message: unknown): Promise<T | undefined> {
  if (!extAlive()) return Promise.resolve(undefined);
  try {
    return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

/** storage.session helpers that no-op once the context is gone. */
function safeStorageGet(key: string): Promise<Record<string, unknown>> {
  if (!extAlive()) return Promise.resolve({});
  try {
    return Promise.resolve(chrome.storage.session.get(key)).catch(() => ({}));
  } catch {
    return Promise.resolve({});
  }
}
function safeStorageSet(items: Record<string, unknown>): Promise<void> {
  if (!extAlive()) return Promise.resolve();
  try {
    return Promise.resolve(chrome.storage.session.set(items)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

export default defineContentScript({
  matches: ['https://calendar.google.com/*'],
  main() {
    // The id of the most recently clicked event chip — the event whose popover
    // is opening. Reset when the surface closes so a later unrelated dialog
    // can't resurrect a stale button.
    let clickedEid: string | null = null;
    let lastSnapshot: DomEventSnapshot | null = null;
    let panelOpen = false;
    // The dialog node we've accepted as an event surface. Held so recognition is
    // sticky for the life of that node (see readSurface) — kills the button flicker.
    let eventDialog: HTMLElement | null = null;
    let followedEid: string | null = null; // last event auto-pushed to the panel
    let pendingMagic: { eid: string; eventId: string; title: string } | null = null;
    let everSawEventId = false;
    // Set by readSurface when a non-event modal is open (a confirmation): we keep the
    // injected button in the form behind it, but must not float the FAB over the modal.
    let suppressFab = false;

    // Button UI: a native injected button when a clean anchor exists, else a
    // floating fallback (Idea 2). The magic-address gate is dropped — the button
    // shows on any open event surface; clicking it IS the intent.
    const button = createButtonUI(() => {
      if (!lastSnapshot) return;
      // Always hand the click to the background as OPEN_FOR_EVENT. The
      // background is the single authority on whether the panel is connected
      // (it owns the panel's port): it calls sidePanel.open only when the panel
      // is closed, and otherwise just points the open panel at this event. We
      // deliberately do NOT branch on a local panelOpen/opening flag here — those
      // drift out of sync (a missed PANEL_STATE, or a failed open leaving a latch
      // stuck) and were the reason a click sometimes silently did nothing.
      openFor(lastSnapshot);
      // Note: we intentionally do NOT navigate the tab to the event here. The
      // panel resolves the event itself (Calendar API), so reloading the page
      // adds nothing but cost + surprise. "Open in Calendar" in the panel is the
      // explicit, user-initiated way to jump to the event.
    });

    // In-page nudge banner: visitor events the user saved but hasn't acted on.
    // Driven by the background sync (robust), not live DOM scanning.
    const nudge = mountNudge();
    safeSend<{ ok?: boolean; data?: VisitorEventSummary[] }>({ type: 'GET_NUDGE_TARGETS' }).then(
      (res) => {
        if (res?.ok) nudge.setTargets(res.data as VisitorEventSummary[]);
      },
    );

    // Reconnect banner: shown when the background reports a recoverable auth lapse
    // (the user was connected but a silent token renew failed), so nudging never
    // dies silently. The background broadcasts AUTH_LAPSED on each sync.
    const reconnect = mountReconnect(() => safeSend({ type: 'OPEN_PANEL' }));

    // Seed the panel-open state on (re)load so auto-follow works after a
    // same-tab navigation (the panel persists; this content script is fresh).
    safeSend<{ ok?: boolean; data?: { open: boolean } }>({ type: 'GET_PANEL_STATE' }).then((res) => {
      if (res?.ok) {
        panelOpen = !!res.data?.open;
        nudge.setPanelOpen(panelOpen);
        reconnect.setPanelOpen(panelOpen);
        render();
      }
    });

    // Fast detection: sync on load, on tab focus, and right after leaving the
    // event editor (a likely save) — so the banner appears in seconds, not up
    // to a minute, and shows immediately when the user returns to the tab.
    let lastSync = 0;
    const syncNow = () => {
      const now = Date.now();
      if (now - lastSync < 4000) return; // throttle
      lastSync = now;
      safeSend({ type: 'SYNC_NOW' });
    };
    // Burst: fire several syncs after a likely save to beat Google's API
    // eventual-consistency lag (a fresh events.list may not show the just-saved
    // event for a few seconds).
    let lastBurst = 0;
    const syncBurst = () => {
      const now = Date.now();
      if (now - lastBurst < 2000) return;
      lastBurst = now;
      for (const d of [0, 3000, 8000]) {
        setTimeout(() => safeSend({ type: 'SYNC_NOW' }), d);
      }
    };
    syncNow();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow();
    });
    window.addEventListener('focus', syncNow);
    let wasEditor = /\/eventedit/.test(location.pathname);
    const editorPoll = setInterval(() => {
      if (!extAlive()) return teardown(); // orphaned by an extension reload → stop
      const isEditor = /\/eventedit/.test(location.pathname);
      if (wasEditor && !isEditor) syncBurst(); // left the editor → likely saved
      wasEditor = isEditor;
      // Safety net: re-assert the button. The MutationObserver is debounced, so a
      // continuous scroll (which fires mutations faster than the debounce) can
      // starve it and never re-run render after Google re-renders the modal and
      // drops our injected button. This guarantees it comes back within ~1s.
      render();
    }, 1000);

    // Stop all work once our context is invalidated (extension reloaded/updated),
    // so an orphaned script doesn't keep observing/polling — and remove our now-
    // dead button (its click can't reach the background) instead of leaving a
    // zombie that looks live but does nothing.
    let disposed = false;
    function teardown() {
      if (disposed) return;
      disposed = true;
      clearInterval(editorPoll);
      observer.disconnect();
      button.update(false);
    }

    /** Read the open event surface, or null if none is open. `eid` may be '' for
     *  a brand-new, not-yet-saved event (no data-eventid / URL eid yet). */
    function readSurface(): { el: HTMLElement; eid: string } | null {
      suppressFab = false;
      const fromUrl = urlEid();
      const onEditor = /\/eventedit/.test(location.pathname);
      // Only VISIBLE dialogs count. Google leaves hidden [role="dialog"] nodes in the
      // DOM (the Google Meet / "add conferencing" picker, recurrence + notification
      // menus, transient loaders that flash while a section streams in). A hidden
      // leftover must NEVER be mistaken for an open confirmation that suppresses our
      // button — treating it as one is exactly what made the button vanish the moment
      // Calendar lazy-loaded something (e.g. the Meet link) and never return until the
      // surface was reopened.
      // STICKY by node identity: once a dialog is accepted as the event surface, keep
      // returning it as long as that NODE stays connected AND visible — even while its
      // innards momentarily fail the isEventDialog heuristic (its data-eventid row gets
      // swapped, the content list rebuilt) as Google streams content in. Re-running the
      // heuristic every tick is what let the surface read as "gone" mid-load and hid
      // the button. Drop it only when the node truly leaves the DOM or is hidden (i.e.
      // the popover was closed).
      if (eventDialog && (!eventDialog.isConnected || !isVisible(eventDialog))) {
        eventDialog = null;
      }
      if (eventDialog) {
        return { el: eventDialog, eid: fromUrl ?? clickedEid ?? '' };
      }

      // No sticky surface yet → recognize one. Only VISIBLE dialogs count: Google
      // leaves hidden [role="dialog"] leftovers in the DOM (the Meet/recurrence pickers,
      // transient loaders) that must never be mistaken for a confirmation that
      // suppresses our button.
      const dialog = (
        Array.from(document.querySelectorAll('[role="dialog"]')) as HTMLElement[]
      ).filter(isVisible)[0] ?? null;
      if (dialog) {
        if (isEventDialog(dialog)) {
          eventDialog = dialog;
          return { el: dialog, eid: fromUrl ?? clickedEid ?? '' };
        }
        // A visible NON-event dialog (e.g. the "Send update emails?" confirmation). If
        // the real surface is the edit PAGE underneath (URL eid / eventedit), keep the
        // button in that page's form; otherwise this dialog is the sole surface, so
        // suppress. Either way, don't float the FAB over the modal.
        suppressFab = true;
        if (!fromUrl && !onEditor) return null;
      }

      if (fromUrl) return { el: document.body, eid: fromUrl };
      // Full-screen create/edit editor. An existing event always carries its eid in
      // the URL (handled above), so reaching here means a brand-new, unsaved event →
      // eid ''. Never fall back to clickedEid: it can be stale from a previously
      // viewed event and would point the panel at the wrong one.
      if (onEditor) return { el: document.body, eid: '' };
      return null;
    }

    function snapshotOf(el: HTMLElement, eid: string): DomEventSnapshot {
      const text = el.innerText || '';
      const lower = text.toLowerCase();
      const magicPresent = !!MAGIC_ADDRESS && lower.includes(MAGIC_ADDRESS);
      const guestEmails = extractEmails(text).filter(
        (e) => e.toLowerCase() !== MAGIC_ADDRESS,
      );
      // Best-effort title (cosmetic — the API sync replaces it). The full editor
      // exposes the title as a text input; the detail popover (the common case)
      // shows it as a heading, not an input — so fall back to the open dialog's
      // heading / accessible name. Scoped to the dialog so we never grab the
      // page's own H1 ("Calendar") when no event surface is open.
      const titleInput = el.querySelector(
        'input[aria-label*="title" i], input[placeholder*="title" i]',
      ) as HTMLInputElement | null;
      const dialog = el.matches?.('[role="dialog"]')
        ? el
        : el.querySelector<HTMLElement>('[role="dialog"]');
      const heading = dialog?.querySelector<HTMLElement>('[role="heading"], h1, h2');
      const title =
        titleInput?.value?.trim() ||
        heading?.innerText?.trim() ||
        dialog?.getAttribute('aria-label')?.trim() ||
        undefined;
      return { eid, magicPresent, guestEmails, title };
    }

    function render() {
      if (!extAlive()) return teardown(); // orphaned by an extension reload → stop
      const surface = readSurface();
      lastSnapshot = surface ? snapshotOf(surface.el, surface.eid) : null;

      // Instant nudge: while viewing a visitor event WITH a real eid, remember
      // it; when the user then leaves that surface (closed popover / saved &
      // left editor), show the nudge for it IMMEDIATELY — no API round-trip.
      if (lastSnapshot?.magicPresent && lastSnapshot.eid) {
        pendingMagic = {
          eid: lastSnapshot.eid,
          eventId: decodeEventId(lastSnapshot.eid),
          title: lastSnapshot.title ?? '',
        };
      } else if (!surface && pendingMagic) {
        const pm = pendingMagic;
        pendingMagic = null;
        // Only show the INSTANT nudge when we actually scraped a title — a nameless
        // banner reads as broken (the user's report). If the title scrape missed,
        // skip the optimistic path and let the (now bounded, ~2s) API sync deliver
        // the named nudge a moment later. syncBurst fires either way.
        if (pm.title) {
          // …but NOT for an event whose passes are already sent, or one the user is
          // only a GUEST of: viewing+closing it must not nudge. The sync set filters
          // both, but this optimistic path bypasses it — so ask the background to
          // confirm (not handled AND the user is the organizer) before showing the
          // instant nudge.
          safeSend<{ ok?: boolean; data?: { worthy?: boolean } }>({
            type: 'IS_NUDGE_WORTHY',
            eid: pm.eid,
            eventId: pm.eventId,
          }).then((res) => {
            if (!res?.ok || !res.data?.worthy) return; // already done / not host → no nudge
            nudge.addOptimistic({
              eid: pm.eid,
              eventId: pm.eventId,
              iCalUid: '',
              title: pm.title,
              start: undefined,
            });
          });
        }
        syncBurst(); // confirm/refresh from the API right after (named nudge)
      }

      // Show the button on any open event surface — including while the panel is
      // open. We keep the floating fallback available even then: a missing button
      // reads as broken (the user's report), and the native in-popover button can
      // lose the first-open injection race. The grace period in update() still
      // lets the native button win whenever it injects in time, so the FAB only
      // appears as a genuine last resort. (We no longer navigate the tab on click,
      // so the old "flash while a navigated page loads" concern is moot.) The FAB is
      // held back while a non-event modal is up so it never floats over a confirmation.
      // Pass the resolved surface element so the button anchors INSIDE it (never a
      // hidden leftover dialog) and re-places itself if a re-render drifts it out.
      button.update(!!surface, !suppressFab, surface?.el ?? null);
      if (panelOpen) maybeFollow();
    }

    /** Push the open *saved* event to the panel so it follows what you're viewing.
     *  Saved only (non-empty eid); deduped; the panel guards against switching
     *  mid-action. */
    function maybeFollow() {
      const snap = lastSnapshot;
      if (!snap || !snap.eid) return; // new/unsaved events don't auto-switch
      if (snap.eid === followedEid) return;
      followedEid = snap.eid;
      safeSend({ type: 'FOLLOW_EVENT', eid: snap.eid, snapshot: snap });
    }

    document.addEventListener(
      'click',
      (e) => {
        const chip = (e.target as Element | null)?.closest?.('[data-eventid]');
        const id = chip?.getAttribute('data-eventid');
        if (id) {
          everSawEventId = true;
          clickedEid = id;
        }
        // Re-check a few times: Google paints the popover progressively, so a
        // single 60ms probe can land before the surface (or its rows) exist,
        // and we'd then wait up to a second for the safety-net poll. Staggered
        // probes catch a slow paint quickly; render() is idempotent + cheap.
        for (const d of [60, 250, 600]) setTimeout(render, d);
      },
      true,
    );

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          clickedEid = null;
          setTimeout(render, 60);
        }
      },
      true,
    );

    // Detect surface open/close + edits (e.g. adding the magic address live).
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      // Flicker-free keep-alive FIRST, synchronously: if Google's re-render just
      // detached our button, re-place it in this same microtask (before paint) rather
      // than waiting out the 150ms debounce below — that gap was the visible flicker,
      // and a re-render landing as a lazy section finishes loading could otherwise drop
      // the button until the next poll. The full re-evaluation still runs debounced.
      button.keepAlive();
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!document.querySelector('[role="dialog"]') && !urlEid()) {
          clickedEid = null;
        }
        render();
      }, 150) as unknown as number;
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('popstate', render);

    // Hide the in-page button while the side panel is open.
    chrome.runtime.onMessage.addListener(
      (msg: {
        type?: string;
        open?: boolean;
        targets?: VisitorEventSummary[];
        cancelled?: string[];
        lapsed?: boolean;
      }) => {
        if (msg?.type === PANEL_STATE) {
          panelOpen = !!msg.open;
          if (!panelOpen) followedEid = null; // re-follow next time it opens
          nudge.setPanelOpen(panelOpen); // banner hides while the panel is open
          reconnect.setPanelOpen(panelOpen);
          render();
        } else if (msg?.type === NUDGE_TARGETS) {
          nudge.setTargets(msg.targets ?? [], msg.cancelled ?? []);
        } else if (msg?.type === AUTH_LAPSED) {
          reconnect.setLapsed(!!msg.lapsed);
        }
      },
    );

    setTimeout(() => {
      if (!everSawEventId && !document.querySelector('[data-eventid]')) {
        console.warn(
          '[auxilio] no [data-eventid] found — click detection may be unavailable; use the panel’s event list.',
        );
      }
    }, 90_000);

    render();
    console.log('[auxilio] content script ready on Google Calendar');
  },
});

function openFor(snapshot: DomEventSnapshot) {
  return safeSend({ type: 'OPEN_FOR_EVENT', eid: snapshot.eid, snapshot });
}

/** Event id from the expanded-edit URL path, if present. */
function urlEid(): string | null {
  const path = location.pathname.match(/\/eventedit\/([^/?#]+)/);
  if (path && path[1] !== 'eventedit') return safeDecode(path[1]);
  const q = new URLSearchParams(location.search).get('eid');
  return q ? safeDecode(q) : null;
}

/** Pull unique email-looking strings from text (best-effort guest scrape). */
function extractEmails(text: string): string[] {
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

/** eid (base64url of "<eventId> <calendarId>") → eventId, for nudge dedup. */
function decodeEventId(eid: string): string {
  try {
    let b64 = eid.replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    return atob(b64).split(' ')[0] || '';
  } catch {
    return '';
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const USERS_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
  <path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;

const LABEL = 'Manage Visitors';
const INJECT_ID = 'auxilio-manage-visitors';

// Detail-popover content row copy — mirrors Google's own rows (bold action + muted
// description), e.g. "Take meeting notes / Start a new document to capture notes".
const ROW_TITLE = 'Manage visitors';
const ROW_SUB = 'Register guests and send entry passes';

/** The Auxilio mark, flattened to a single brand-purple fill and self-contained (no
 *  gradients/ids/<style> that could leak into or collide with the host page). Sized by
 *  its container so it lines up with Google's own row icons. */
// viewBox cropped to the mark's actual bounds (the source art has ~13px of dead margin
// top/bottom that made the icon render small and high) so it fills its 20px box like
// Google's own row icons.
const AUXILIO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 12 140 126" aria-hidden="true" focusable="false">
  <path fill="#8B228C" d="m144 115-47.1-88.6c-3.8-7.4-10.8-13.4-21.3-13.4s-17.9 6.1-21.6 13.3l-47.8 87.7c-2.3 3.7-3.7 11.5 1.5 17.4s13 6.3 18 4.8 7.3-4.2 9.3-9.2l25.7-46.5c2.9-8.1 11.3-8.5 14.5-8.5 8 0 12.8 4.2 15.8 9.5l24.9 47.5c7.1 11.4 24.1 9.9 28.6-0.5 3.1-7.6 0.1-12.5-0.5-13.5z"/>
  <path fill="#8B228C" d="m75.2 104c-8.5-0.1-15.2 6.5-16.2 14s3 18 16 18.5c11.2 0 16-7.5 16-16.5s-7.3-15.9-15.8-16z"/>
</svg>`;

/**
 * Button UI manager: injects a native-styled "Manage Visitors" button as a real,
 * full-width row in the surface — below the Availability/Visibility section on the
 * edit page, at the bottom of the outermost content list in the detail popover (so
 * it scrolls with the rest of the UI, never an overlay) — and falls back to a
 * floating button only when no anchor is found. `update(show)` decides per render.
 */
function createButtonUI(onClick: () => void) {
  const fab = mountFloating(onClick);
  // Saved-event detail popover: a native-style row in the scrollable content list.
  const popover = mountContentRow(onClick);
  let injected: HTMLElement | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // Last decision from update(), so keepAlive() can re-place the button synchronously
  // (flicker-free) when a Google re-render detaches it, without recomputing the surface.
  let lastShow = false;
  let lastSurfaceEl: HTMLElement | null = null;
  // Which placement the current surface uses, decided once per update() so keepAlive()
  // doesn't have to re-detect it on every mutation. 'row' = detail-popover content row;
  // 'inline' = editor page or quick-create popover (inline button next to Save).
  let surfaceMode: 'row' | 'inline' | null = null;

  // A clean injection anchor: where to drop the button + how far to indent it so
  // it lines up with the section's content column (past Google's icon gutter).
  // `inline` = sit next to a native button instead of as its own row.
  type Anchor = {
    insert: (el: HTMLElement) => void;
    inset: number;
    inline?: boolean;
  };

  /** Text/ARIA-based only — never CSS classes — so we stay decoupled from
   *  Google's obfuscated markup. Places the button where it reads as part of the
   *  form: between Description and the next section on the edit page, and as the
   *  last row of the detail popover's content list. Floating only as last resort. */
  function findAnchor(surfaceEl: HTMLElement | null): Anchor | null {
    // Anchor strictly within the surface readSurface identified. We use the PASSED
    // element, never document.querySelector('[role="dialog"]') — that returned the
    // first dialog in DOM order, which while Calendar lazy-loads (the Meet link, etc.)
    // can be a HIDDEN leftover dialog. Injecting into it placed the button in an
    // invisible node, so it "vanished" and (being isConnected) never re-placed itself
    // until the surface was reopened.
    const dialog =
      surfaceEl && surfaceEl.matches?.('[role="dialog"]') ? surfaceEl : null;

    // Inline next to the native "Save" — both the full editor page AND the quick-create
    // popover for an UNSAVED event (which carries "More options" + "Save"). Scope the
    // search to the dialog when we're in one so we never grab a Save from elsewhere.
    const save = findButtonByTextIn(dialog ?? document, 'save');
    const saveParent = save?.parentElement;
    if (save && saveParent) {
      return { insert: (el) => saveParent.insertBefore(el, save), inset: 0, inline: true };
    }

    // A saved-event detail popover has no Save → its button is the Google-style content
    // row (handled by mountContentRow), not an inline anchor.
    if (dialog) return null;

    // Page surface (full-screen editor, or a url-eid view): our own full-width row just
    // BELOW the Availability/Visibility info section, else above Description.
    const avail = findAvailabilityInfo();
    const afterAvail = avail ? rowsListFor(avail) : null;
    if (afterAvail) {
      const { list, row } = afterAvail;
      return { insert: (el) => list.insertBefore(el, row.nextSibling), inset: rowInset(row, list) };
    }
    const desc = findEditDescription();
    const aboveDesc = desc ? rowsListFor(desc) : null;
    if (aboveDesc) {
      const { list, row } = aboveDesc;
      return { insert: (el) => list.insertBefore(el, row), inset: rowInset(row, list) };
    }
    return null;
  }

  function ensureInjected(surfaceEl: HTMLElement | null): boolean {
    // Keep the button only if it's still placed AND still inside the CURRENT surface.
    // The contains() check is essential: after Calendar re-renders, our button can be
    // left attached to a stale/hidden subtree (isConnected stays true), which would
    // otherwise read as "placed" forever and never recover. Re-place it when it has
    // drifted out of the surface we're now decorating.
    if (
      injected &&
      injected.isConnected &&
      (!surfaceEl || surfaceEl.contains(injected))
    ) {
      return true;
    }
    const anchor = findAnchor(surfaceEl);
    if (!anchor) return false;
    removeInjected();
    ensureInjectedStyles();
    injected = anchor.inline
      ? buildInlineButton(onClick)
      : buildInjectedRow(onClick, anchor.inset);
    anchor.insert(injected);
    return true;
  }

  function removeInjected() {
    injected?.remove();
    injected = null;
  }

  // Debounce HIDING so a transient "surface gone" tick during Google's initial
  // SPA hydration (it tears the event surface down and rebuilds it several times
  // on a page refresh) doesn't flash the button away and back. We only remove the
  // button if the surface stays gone for HIDE_GRACE_MS; a re-appearance cancels it.
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const HIDE_GRACE_MS = 400;

  return {
    // `allowFab` gates the floating fallback. It's only there to surface the
    // panel when we can't inject a native button; with the panel already open
    // it's redundant (auto-follow handles the viewed event), and it would flash
    // at the corner while a navigated page is still loading. So callers pass
    // false when the panel is open.
    update(show: boolean, allowFab = true, surfaceEl: HTMLElement | null = null) {
      lastShow = show;
      lastSurfaceEl = surfaceEl;
      clearTimeout(retryTimer);
      if (!show) {
        // Defer the hide: if the surface comes right back (hydration churn / a transient
        // tick where readSurface can't see the dialog during the load reconciliation),
        // the next update(true) cancels this and nothing visibly disappears. The popover
        // row gets the SAME grace as the editor button.
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          surfaceMode = null;
          removeInjected();
          fab.setVisible(false);
          popover.hide();
        }, HIDE_GRACE_MS);
        return;
      }
      clearTimeout(hideTimer); // surface is present → cancel any pending hide (incl. popover)

      const dialog = surfaceEl && surfaceEl.matches?.('[role="dialog"]') ? surfaceEl : null;

      // SAVED-EVENT DETAIL POPOVER (no native Save) → native-style row in the scrollable
      // content list. Placed after the first-open storm, instant on re-open. No FAB.
      if (dialog && !findButtonByTextIn(dialog, 'save')) {
        surfaceMode = 'row';
        removeInjected();
        fab.setVisible(false);
        popover.show(dialog);
        return;
      }

      // EDITOR PAGE or QUICK-CREATE POPOVER (unsaved event, has Save) → native inline
      // button next to More options / Save (stable; never had the popover bug).
      surfaceMode = 'inline';
      popover.hide();
      // Try to inject now; if the anchor isn't in the DOM / laid out yet (Google
      // is still rendering the surface), keep retrying for a few seconds. The
      // MutationObserver covers DOM changes, but layout can settle — giving
      // elements their width — without a childList mutation, so width-based
      // anchor checks can miss that window. This retry guarantees we don't.
      let attempts = 0;
      const attempt = () => {
        const placed = ensureInjected(surfaceEl);
        // Show the floating fallback only after a short grace period, so on a
        // normally-rendering surface the native button just appears — no flash
        // of the FAB getting replaced a moment later.
        fab.setVisible(allowFab && !placed && attempts >= 3);
        if (placed || attempts++ >= 30) return;
        retryTimer = setTimeout(attempt, 150);
      };
      attempt();
    },

    // Synchronous re-assert from the MutationObserver on every DOM change. POPOVER: tell
    // the content-row manager (re-add the row if a re-render removed it). EDITOR: re-place
    // the injected button if it was detached — in the SAME microtask, before paint.
    keepAlive() {
      if (!lastShow) return; // surface not shown → nothing to keep alive
      const el = lastSurfaceEl;
      if (el && (!el.isConnected || !isVisible(el))) return; // stale → let render() recompute
      // Detail-popover content row: let the row manager repair it (cheap node-identity
      // check; no per-mutation Save lookup — surfaceMode was decided in update()).
      if (surfaceMode === 'row') {
        popover.onMutation();
        return;
      }
      if (injected && injected.isConnected && (!el || el.contains(injected))) return; // still placed
      ensureInjected(el);
    },
  };
}

/**
 * Is this open `[role="dialog"]` an actual event surface (detail popover / quick
 * edit), rather than one of Google's transient confirmation dialogs — e.g.
 * "Send update emails to existing Google Calendar guests?" or "Delete this
 * event?" — which we must not decorate? Positive, stable signals only: an event
 * chip id, the magic address in its text, or several icon-led section rows
 * (time / guests / location). A confirmation dialog is just a question plus a
 * row of action buttons, so it matches none of these.
 */
function isEventDialog(dialog: HTMLElement): boolean {
  if (dialog.querySelector('[data-eventid]')) return true;
  // A title input means this is an event create/edit surface (the quick-create popover
  // for a brand-new, unsaved event — no eid/magic address yet). Confirmation dialogs
  // ("Delete?", "Send update emails?") have no title input, so this stays specific.
  if (dialog.querySelector('input[aria-label*="title" i], input[placeholder*="title" i]')) return true;
  const text = (dialog.innerText || '').toLowerCase();
  if (MAGIC_ADDRESS && text.includes(MAGIC_ADDRESS)) return true;
  return !!findContentList(dialog);
}

/** Find a VISIBLE clickable element within `scope` whose visible text matches
 *  (case-insensitive). */
function findButtonByTextIn(scope: ParentNode, text: string): HTMLElement | null {
  const wanted = text.toLowerCase();
  for (const el of scope.querySelectorAll<HTMLElement>('button,[role="button"]')) {
    if ((el.textContent ?? '').trim().toLowerCase() === wanted && isVisible(el)) return el;
  }
  return null;
}

/** Find a clickable element whose visible text matches (case-insensitive), document-wide. */
function findButtonByText(text: string): HTMLElement | null {
  return findButtonByTextIn(document, text);
}

const isVisible = (el: HTMLElement) => el.offsetParent !== null || el.getClientRects().length > 0;

/** The Description editor on the event edit page. ARIA/placeholder text only —
 *  never CSS classes (Google's are obfuscated and churn). */
function findEditDescription(): HTMLElement | null {
  const els = document.querySelectorAll<HTMLElement>(
    '[aria-label*="description" i], [placeholder*="description" i]',
  );
  for (const el of els) if (isVisible(el)) return el;
  return null;
}

/** The Availability/Visibility info block on the edit page. Prefers Google's
 *  stable `jsname` hook, falling back to the info text. */
function findAvailabilityInfo(): HTMLElement | null {
  const byJsname = document.querySelector<HTMLElement>('[jsname="g7cnnb"]');
  if (byJsname && isVisible(byJsname)) return byJsname;
  for (const el of document.querySelectorAll<HTMLElement>('span,div')) {
    const t = (el.textContent ?? '').trim().toLowerCase();
    if (t.startsWith('availability might be shown') && isVisible(el)) return el;
  }
  return null;
}

/** The OUTERMOST rows list inside `root`: the shallowest container whose own
 *  children include several icon-led section rows. Breadth-first so a nested
 *  guest list never wins over the main content list. */
function findContentList(root: HTMLElement): HTMLElement | null {
  const queue: HTMLElement[] = [];
  for (const c of root.children) if (c instanceof HTMLElement) queue.push(c);
  while (queue.length) {
    const el = queue.shift()!;
    if (!isVisible(el)) continue;
    if (iconLedRowCount(el) >= 2) return el;
    for (const c of el.children) if (c instanceof HTMLElement) queue.push(c);
  }
  return null;
}

/** The first wide icon-led row in a list — a reference for measuring the text
 *  column inset. */
function firstIconLedRow(list: HTMLElement): HTMLElement | null {
  const lw = list.getBoundingClientRect().width;
  for (const c of list.children) {
    if (!(c instanceof HTMLElement) || !isVisible(c) || !looksLikeRow(c)) continue;
    if (lw > 0 && c.getBoundingClientRect().width < lw * 0.5) continue;
    return c;
  }
  return null;
}

/** Does this element stack its visible children vertically (a column of rows),
 *  rather than laying them out side by side? Geometry, not CSS classes. */
function stacksVertically(el: HTMLElement): boolean {
  const kids = [...el.children].filter((c): c is HTMLElement => c instanceof HTMLElement && isVisible(c));
  if (kids.length < 2) return false;
  for (let i = 1; i < kids.length; i++) {
    const a = kids[i - 1].getBoundingClientRect();
    const b = kids[i].getBoundingClientRect();
    if (b.top >= a.bottom - 2) return true; // the next child starts below the previous
  }
  return false;
}

/** A native Calendar content row = a block whose first child is a decorative
 *  (aria-hidden) leading icon, followed by content. This is the one stable,
 *  class-free signal Google keeps across both the popover and the edit page. */
function looksLikeRow(el: HTMLElement): boolean {
  const first = el.firstElementChild;
  return (
    !!first &&
    el.childElementCount >= 2 &&
    (first.getAttribute('aria-hidden') === 'true' ||
      !!first.querySelector('svg, img, i.google-material-icons'))
  );
}

/** How many of a container's visible children are icon-led *section* rows.
 *  Rows must span most of the container's width, which excludes narrow icon
 *  clusters like a description formatting toolbar. */
function iconLedRowCount(container: HTMLElement): number {
  const cw = container.getBoundingClientRect().width;
  let n = 0;
  for (const c of container.children) {
    if (!(c instanceof HTMLElement) || !isVisible(c) || !looksLikeRow(c)) continue;
    if (cw > 0 && c.getBoundingClientRect().width < cw * 0.5) continue; // skip toolbars/chips
    n++;
  }
  return n;
}

/** From a field/label, climb to the rows list that holds it: the first ancestor
 *  whose parent contains several icon-led rows. Returns that list plus the row
 *  (a direct child of the list) that contains `el` — so we can insert relative
 *  to it. Null if no rows list is recognised. */
function rowsListFor(el: HTMLElement): { list: HTMLElement; row: HTMLElement } | null {
  let node: HTMLElement = el;
  while (node.parentElement && node.parentElement !== document.body) {
    const parent = node.parentElement;
    if (iconLedRowCount(parent) >= 2) return { list: parent, row: node };
    node = parent;
  }
  return null;
}

/** The biggest vertically-stacking container inside `root` — the content column
 *  whose last child is the visual bottom of the surface. */
function mainVerticalList(root: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (!isVisible(el) || !stacksVertically(el)) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

/** Left indent (px) that lines our button up with a native row's *text* column,
 *  past Google's leading icon gutter. Measured from where the row's first text
 *  actually paints, relative to the list we insert into. */
function rowInset(row: HTMLElement, list: HTMLElement): number {
  const gap = firstTextLeft(row) - list.getBoundingClientRect().left;
  return Number.isFinite(gap) && gap > 0 && gap < 240 ? Math.round(gap) : 0;
}

/** Left edge of the first painted text inside `el` (skips the decorative icon
 *  gutter), or the element's own left if it has none. */
function firstTextLeft(el: HTMLElement): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent || !node.textContent.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0) return rect.left;
  }
  return el.getBoundingClientRect().left;
}

/** The scrolling content region inside a surface (overflow-y auto/scroll),
 *  largest first — so our row lives with the content and scrolls, not in a
 *  pinned header/footer. Null when nothing scrolls. */
function scrollContainer(root: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (!isVisible(el)) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

/** Stop our interactions dismissing Google's modal / triggering its buttons. */
function shieldInteractions(el: HTMLElement) {
  for (const type of ['pointerdown', 'mousedown', 'touchstart'] as const) {
    el.addEventListener(
      type,
      (e) => {
        e.stopPropagation();
        e.preventDefault(); // don't move focus out of the Calendar dialog
      },
      true,
    );
  }
  el.addEventListener('click', (e) => e.stopPropagation(), true);
}

const STYLE_ID = 'auxilio-manage-visitors-style';

/** One-time stylesheet for the injected (light-DOM) button. Styled to match a
 *  native Material outlined Calendar button — same shape, size, typography and
 *  hover state-layer — so it reads as part of Google's UI, just brand-tinted. */
function ensureInjectedStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .auxilio-mv-row{
      box-sizing:border-box;display:flex;align-items:flex-start;width:100%;
      padding:6px 16px 6px 28px;
      animation:auxilio-mv-fade 220ms cubic-bezier(.2,0,0,1) both;
    }
    .auxilio-mv-row-icon{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:16px;}
    .auxilio-mv-row-icon svg{width:100%;height:100%;display:block;}
    .auxilio-mv-row-text{display:flex;flex-direction:column;gap:1px;min-width:0;}
    .auxilio-mv-row-title{
      align-self:flex-start;font-family:'Google Sans','Roboto',Arial,sans-serif;
      font-size:14px;line-height:20px;font-weight:500;cursor:pointer;border-radius:4px;
    }
    .auxilio-mv-row-title:hover{text-decoration:underline;}
    .auxilio-mv-row-title:focus-visible{outline:2px solid #92288e;outline-offset:2px;}
    .auxilio-mv-row[aria-busy="true"] .auxilio-mv-row-title{opacity:.6;cursor:default;text-decoration:none;}
    .auxilio-mv-row-sub{font-family:'Roboto',Arial,sans-serif;font-size:12px;line-height:16px;font-weight:400;opacity:.72;}
    @keyframes auxilio-mv-fade{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
    @media (prefers-reduced-motion:reduce){.auxilio-mv-row{animation:none;}}
    .auxilio-mv-btn{
      box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;
      font-family:'Google Sans','Roboto',Arial,sans-serif;font-size:14px;font-weight:500;
      line-height:20px;letter-spacing:.25px;color:#92288e;background:transparent;
      border:1px solid #747775;border-radius:999px;padding:8px 18px 8px 14px;
      min-height:40px;cursor:pointer;white-space:nowrap;
      transition:background-color 120ms ease,border-color 120ms ease;
    }
    .auxilio-mv-btn:hover{background:rgba(146,40,142,.08);}
    .auxilio-mv-btn:active{background:rgba(146,40,142,.12);}
    .auxilio-mv-btn:focus-visible{outline:2px solid #92288e;outline-offset:2px;}
    .auxilio-mv-btn[disabled]{opacity:.6;cursor:default;}
    .auxilio-mv-btn svg{width:18px;height:18px;flex:0 0 auto;}
    /* Icon Button (Header) */
    .auxilio-mv-icon-wrapper { position: relative; display: inline-flex; margin-right: 4px; }
    .auxilio-mv-icon-btn {
      box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;
      width:40px;height:40px;border-radius:50%;background:transparent;
      color:#92288e;border:none;cursor:pointer;margin:4px;
      transition:background-color 120ms ease;
    }
    .auxilio-mv-icon-btn:hover{background:rgba(146,40,142,.08);}
    .auxilio-mv-icon-btn:active{background:rgba(146,40,142,.12);}
    .auxilio-mv-icon-btn:focus-visible{outline:2px solid #92288e;outline-offset:2px;}
    .auxilio-mv-icon-btn svg{width:20px;height:20px;flex:0 0 auto;}
    .auxilio-mv-icon-tooltip { 
      position: absolute; bottom: -30px; left: 50%; transform: translateX(-50%);
      background: rgba(60,64,67,0.9); color: white; padding: 6px 8px; border-radius: 4px;
      font-size: 12px; font-family: Roboto, sans-serif; white-space: nowrap; font-weight: 500;
      opacity: 0; pointer-events: none; transition: opacity 100ms; z-index: 1000;
    }
    .auxilio-mv-icon-wrapper:hover .auxilio-mv-icon-tooltip { opacity: 1; transition-delay: 350ms; }
  `;
  document.documentElement.appendChild(s);
}

/** The native-styled button itself (light DOM, classes from ensureInjectedStyles). */
function makeNativeButton(onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'auxilio-mv-btn';
  btn.innerHTML = `${USERS_SVG}<span>${LABEL}</span>`;
  shieldInteractions(btn);
  wireActivate(btn, onClick);
  return btn;
}

/** A full-width row carrying the button, indented to align with the section
 *  content column. Flows like a native section, so it can't overlap siblings. */
function buildInjectedRow(onClick: () => void, inset: number): HTMLElement {
  const row = document.createElement('div');
  row.id = INJECT_ID;
  row.className = 'auxilio-mv-row';
  if (inset) row.style.paddingLeft = `${inset}px`;
  row.appendChild(makeNativeButton(onClick));
  // Guard only the row's empty padding — clicks there must not dismiss Google's
  // surface; the button manages its own interactions (shieldInteractions).
  shieldPadding(row);
  return row;
}

/** Event ids whose popover we've already placed into once this page session. Google
 *  reconciles a given event's popover only on its FIRST open per session, so a remembered
 *  event re-opens with its content already present → we can place instantly, no delay. */
const seenEventPopovers = new Set<string>();

/** Populate `row` with a native-style Calendar content row: an Auxilio icon in the
 *  left gutter, then a bold action title with a muted description under it (mirroring
 *  rows like "Take meeting notes / Start a new document to capture notes"). Only the
 *  TITLE is the control (like Google's "Join with Google Meet" link); the icon and the
 *  description are inert. Returns the title element — our integrity marker. */
function buildContentRowInner(row: HTMLElement): HTMLElement {
  row.textContent = '';
  const icon = document.createElement('span');
  icon.className = 'auxilio-mv-row-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = AUXILIO_SVG;
  const text = document.createElement('span');
  text.className = 'auxilio-mv-row-text';
  const title = document.createElement('span');
  title.className = 'auxilio-mv-row-title';
  title.textContent = ROW_TITLE;
  title.setAttribute('role', 'button');
  title.tabIndex = 0;
  const sub = document.createElement('span');
  sub.className = 'auxilio-mv-row-sub';
  sub.textContent = ROW_SUB;
  text.append(title, sub);
  row.append(icon, text);
  return title;
}

/** Match our row to a native sibling row: the same padding (the real left gutter),
 *  the same icon size and icon→text gap so our icon lines up with Google's, the same
 *  icon vertical offset, and the host theme's text color (so it reads identically in
 *  light and dark). Computed-style/geometry only — measured ONCE at placement, never
 *  per mutation. Falls back to sane defaults when no reference row is available. */
function styleContentRowLikeNative(row: HTMLElement, list: HTMLElement): void {
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const icon = row.querySelector<HTMLElement>('.auxilio-mv-row-icon');
  const text = row.querySelector<HTMLElement>('.auxilio-mv-row-text');
  const title = row.querySelector<HTMLElement>('.auxilio-mv-row-title');
  const sub = row.querySelector<HTMLElement>('.auxilio-mv-row-sub');
  const ICON_SIZE = 20; // fixed icon box
  const PAD_LEFT = 28;  // fixed padding from left wall
  const ICON_GAP = 20;  // fixed gap between icon and text

  const ref = firstIconLedRow(list);
  if (!ref) {
    row.style.padding = `6px 16px 6px ${PAD_LEFT}px`;
    if (icon) { icon.style.width = `${ICON_SIZE}px`; icon.style.height = `${ICON_SIZE}px`; icon.style.marginRight = `${ICON_GAP}px`; }
    if (title) title.style.fontWeight = 'bold';
    return;
  }

  // 1. Copy native vertical/right padding programmatically (style + geometry), but enforce fixed 28px left padding
  const rs = getComputedStyle(ref);
  const refText = ref.children[1] as HTMLElement | null;
  const rts = refText ? getComputedStyle(refText) : null;
  const refTitle = refText?.children[0] as HTMLElement | null;
  const refSub = refText?.children[1] as HTMLElement | null;

  let padTop = parseFloat(rs.paddingTop) || (rts ? parseFloat(rts.paddingTop) : 0) || (rts ? parseFloat(rts.marginTop) : 0);
  if (!padTop && refTitle) {
    padTop = Math.max(0, Math.round(refTitle.getBoundingClientRect().top - ref.getBoundingClientRect().top));
  }
  padTop = padTop > 0 ? padTop : 6;

  let padBottom = parseFloat(rs.paddingBottom) || (rts ? parseFloat(rts.paddingBottom) : 0) || (rts ? parseFloat(rts.marginBottom) : 0);
  if (!padBottom && refText) {
    const lastEl = refText.lastElementChild || refText;
    padBottom = Math.max(0, Math.round(ref.getBoundingClientRect().bottom - lastEl.getBoundingClientRect().bottom));
  }
  padBottom = padBottom > 0 ? padBottom : 6;

  let padRight = parseFloat(rs.paddingRight) || (rts ? parseFloat(rts.paddingRight) : 0);
  padRight = padRight > 0 ? padRight : 16;

  row.style.padding = `${padTop}px ${padRight}px ${padBottom}px ${PAD_LEFT}px`;

  // 2. Enforce fixed 20x20 icon size and 20px right margin, programmatically align top offset
  const rowRect = ref.getBoundingClientRect();
  const refIcon = ref.firstElementChild as HTMLElement | null;
  const realIcon = refIcon?.querySelector<HTMLElement>('svg, img, i') || refIcon;
  const iconRect = realIcon?.getBoundingClientRect();

  if (icon) {
    const mt = iconRect ? Math.max(0, Math.round(iconRect.top - rowRect.top - padTop)) : 0;
    icon.style.width = `${ICON_SIZE}px`;
    icon.style.height = `${ICON_SIZE}px`;
    icon.style.marginRight = `${ICON_GAP}px`;
    icon.style.marginTop = `${clamp(mt, 0, 6)}px`;
  }

  // 3. Programmatically pull gap between title and subtitle

  if (text && refTitle && refSub) {
    const titleRect = refTitle.getBoundingClientRect();
    const subRect = refSub.getBoundingClientRect();
    const subGap = Math.max(0, Math.round(subRect.top - titleRect.bottom));
    text.style.gap = `${clamp(subGap, 1, 12)}px`;
  }

  // 4. Programmatically pull link color & font sizes, but enforce bold title
  const color = rs.color; // primary text color for the current theme
  const link = list.closest('[role="dialog"]')?.querySelector<HTMLElement>('a[href], [role="link"]');
  const linkColor = link ? getComputedStyle(link).color : '';

  if (title) {
    title.style.color = linkColor || (refTitle ? getComputedStyle(refTitle).color : color);
    if (refTitle) {
      const ts = getComputedStyle(refTitle);
      title.style.fontSize = ts.fontSize;
      title.style.lineHeight = ts.lineHeight;
    }
    title.style.fontWeight = 'bold'; // explicitly enforced per user request
  }

  if (sub) {
    sub.style.color = refSub ? getComputedStyle(refSub).color : color;
    if (refSub) {
      const ss = getComputedStyle(refSub);
      sub.style.fontSize = ss.fontSize;
      sub.style.lineHeight = ss.lineHeight;
      sub.style.fontWeight = ss.fontWeight;
    }
  }
}

/**
 * In-flow "Manage Visitors" row at the bottom of the saved-event detail popover's
 * scrollable content list — styled to read as one of Google's own rows (Auxilio icon +
 * bold action + muted description), aligned to the native gutter and theme colors.
 *
 * Probe-proven (2026-06-29): Google reconciles the entire popover ONCE per page session on
 * an event's first open (~750 mutations, a storm peaking ~480ms). That storm wipes any node
 * placed before it — in the header, content list, AND footer alike — so survival is about
 * TIMING, not location. On a re-open of the same event there is no storm (~33 harmless
 * mutations) and a node placed immediately survives untouched. Two failure modes were seen:
 * the node is removed (STRIPPED) or kept-but-its-contents-replaced (OVERWRITTEN — the
 * keyless content list reusing our node by position).
 *
 * Strategy:
 *  - first open of an event   → settle-gate: place ONCE after the storm goes quiet;
 *  - re-open of a known event → place immediately, no delay (seenEventPopovers);
 *  - re-add net checks INTEGRITY (still connected AND still holds our title), so it repairs
 *    both an overwrite and a strip.
 * The content list, gutter and colors come from Google's class-free row signals
 * (findContentList / firstIconLedRow / firstTextLeft) — no CSS-class coupling.
 */
function mountContentRow(onClick: () => void) {
  ensureInjectedStyles();
  const row = document.createElement('div');
  row.id = INJECT_ID;
  row.className = 'auxilio-mv-row';
  let title = buildContentRowInner(row);

  // ONLY the title is the control (like Google's "Join with Google Meet" link). Activation
  // (pointer + keyboard) lives on the title, reading the LIVE title so a rebuild after an
  // overwrite stays wired. Inline "Opening…" feedback on the title.
  let firing = false;
  const activate = async (e?: Event) => {
    e?.stopPropagation(); // our action only — never bubble to Google's modal
    if (firing) return;
    firing = true;
    row.setAttribute('aria-busy', 'true');
    const prev = title.textContent;
    title.textContent = 'Opening…';
    try { await onClick(); }
    finally { title.textContent = prev; row.removeAttribute('aria-busy'); firing = false; }
  };
  // Delegate from the row (capture) so a rebuilt title needs no re-binding. The title
  // activates; clicks anywhere else on the row (icon, description, padding) are swallowed
  // so they can't dismiss Google's popover, but do nothing.
  const onRow = (e: Event) => {
    if ((e.type === 'pointerup' || e.type === 'click') && title.contains(e.target as Node)) {
      activate(e);
      return;
    }
    e.stopPropagation(); // swallow everything else (incl. pointerdown on the title) so it can't dismiss the popover
  };
  for (const type of ['pointerup', 'click', 'pointerdown', 'mousedown', 'touchstart'] as const) {
    row.addEventListener(type, onRow, true);
  }
  row.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && title.contains(e.target as Node)) {
      e.preventDefault();
      activate(e);
    }
  });

  let dialog: HTMLElement | null = null;
  let eventId = '';
  let list: HTMLElement | null = null; // the scrollable content list
  let placed = false;
  let openAt = 0;
  let lastMut = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let burst = 0;
  let burstStart = 0;
  const MIN_OPEN_MS = 800; // first open: let the reconciliation storm pass before placing
  const QUIET_MS = 400; // ...and only place after it's been quiet this long
  const MAX_MS = 4000; // cap: place even if it never fully settles
  const BURST_CAP = 80;

  const readEventId = (d: HTMLElement): string =>
    d.querySelector('[data-eventid]')?.getAttribute('data-eventid') ?? '';

  /** Healthy = our row is connected AND still carries our title (not overwritten). */
  const healthy = (): boolean => row.isConnected && row.contains(title);

  /** Rebuild our content if the keyless list reused our node and replaced its contents. */
  const repair = (): void => {
    if (row.contains(title)) return;
    title = buildContentRowInner(row);
  };

  /** Place (or repair) the row at the bottom of the content list, styled like a native
   *  row. Synchronous, before paint. */
  const insert = (): void => {
    if (healthy()) return;
    if (!list || !list.isConnected) list = dialog ? findContentList(dialog) : null;
    if (!list) return; // content not ready yet
    const now = Date.now();
    if (now - burstStart > 1000) { burstStart = now; burst = 0; }
    if (burst >= BURST_CAP) return; // runaway guard → degrade, don't freeze
    burst++;
    repair();
    styleContentRowLikeNative(row, list);
    list.appendChild(row); // appendChild also moves it to the end if already present
    placed = true;
    if (eventId) seenEventPopovers.add(eventId);
  };

  /** Place ONCE, after the first-open storm settles — never during the churn. */
  const scheduleSettle = (): void => {
    if (placed) return;
    clearTimeout(settleTimer);
    const sinceOpen = Date.now() - openAt;
    if (sinceOpen >= MAX_MS) { insert(); return; }
    settleTimer = setTimeout(() => {
      if (placed) return;
      if (Date.now() - lastMut >= QUIET_MS && Date.now() - openAt >= MIN_OPEN_MS) insert();
      else scheduleSettle();
    }, Math.max(QUIET_MS, MIN_OPEN_MS - sinceOpen));
  };

  return {
    show(d: HTMLElement): void {
      if (dialog !== d) {
        dialog = d;
        eventId = readEventId(d);
        list = null;
        placed = false;
        openAt = Date.now();
        lastMut = Date.now();
        row.remove();
        clearTimeout(settleTimer);
        if (eventId && seenEventPopovers.has(eventId)) insert(); // re-open: no storm → place now
        if (!placed) scheduleSettle(); // first open (or an instant miss): wait out the storm
      } else if (placed && !healthy()) {
        insert(); // re-place/repair only if genuinely lost
      }
    },
    /** Synchronous, from the MutationObserver on every DOM change. Pre-settle: keep
     *  deferring placement. After placed: repair only if stripped or overwritten. */
    onMutation(): void {
      if (!dialog) return;
      lastMut = Date.now();
      if (placed) {
        if (!healthy()) insert();
      } else {
        scheduleSettle();
      }
    },
    hide(): void {
      row.remove();
      dialog = null;
      list = null;
      placed = false;
      clearTimeout(settleTimer);
    },
  };
}

/** Inline button that sits in the editor / quick-create action bar, next to the
 *  native "More options" / "Save". As an inline-flex box it would otherwise align
 *  to the row's text baseline (riding slightly high with a gap beneath); center it
 *  for both the inline-block case (vertical-align) and the flex-row case (align-self
 *  — so it doesn't stretch taller than its neighbours either). */
function buildInlineButton(onClick: () => void): HTMLButtonElement {
  const btn = makeNativeButton(onClick);
  btn.id = INJECT_ID;
  btn.style.marginRight = '8px';
  btn.style.verticalAlign = 'middle';
  btn.style.alignSelf = 'center';
  return btn;
}

/** Stop interactions on the row's own padding (but not the button) from reaching
 *  Google — so an accidental tap beside the button can't close the dialog. */
function shieldPadding(row: HTMLElement) {
  const guard = (e: Event) => {
    if (e.target === row) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click'] as const) {
    row.addEventListener(type, guard, true);
  }
}

/** Floating fallback button (shadow-DOM, fully isolated). */
function mountFloating(onClick: () => void) {
  const host = document.createElement('div');
  // pointer-events:none so the host box never eats clicks on what's beneath it when
  // the FAB is hidden — the inner button is display:inline-flex even when invisible, so
  // the host keeps a bounding box at bottom-right that would otherwise sit over (and
  // swallow clicks for) Google's own bottom drawer buttons (e.g. the event-edit add-on
  // drawer's "View"). The shown button re-enables hits via `.fab.show{pointer-events:auto}`.
  host.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483646;pointer-events:none;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .fab {
        display:inline-flex;align-items:center;gap:8px;
        font-family:'Google Sans','Roboto',system-ui,sans-serif;font-size:14px;font-weight:600;
        color:#fff;background:#92288e;border:none;border-radius:999px;padding:12px 18px;
        box-shadow:0 2px 6px rgba(0,0,0,.18);cursor:pointer;
        transform:translateY(8px);opacity:0;pointer-events:none;
        transition:opacity 200ms cubic-bezier(.2,0,0,1),transform 200ms cubic-bezier(.2,0,0,1),box-shadow 120ms ease;
      }
      .fab.show{opacity:1;transform:none;pointer-events:auto;}
      .fab:hover{box-shadow:0 4px 12px rgba(0,0,0,.24);}
      .fab:active{transform:scale(.98);}
      .fab[disabled]{opacity:.6;pointer-events:none;}
      @media (prefers-reduced-motion: reduce){.fab{transition:none;transform:none;}}
    </style>
    <button class="fab" type="button">${USERS_SVG}<span class="label">${LABEL}</span></button>`;
  const btn = root.querySelector('button') as HTMLButtonElement;
  shieldInteractions(host);
  wireActivate(btn, onClick);
  return {
    setVisible(v: boolean) {
      btn.classList.toggle('show', v);
    },
  };
}

/** Shared activate handler (pointerup + click, double-fire-guarded). */
function wireActivate(btn: HTMLButtonElement, onClick: () => void) {
  const label = btn.querySelector('span:last-of-type') as HTMLSpanElement | null;
  let firing = false;
  const activate = async () => {
    if (firing) return;
    firing = true;
    btn.disabled = true;
    const prev = label?.textContent;
    if (label) label.textContent = 'Opening…';
    try {
      await onClick();
    } finally {
      btn.disabled = false;
      if (label && prev) label.textContent = prev;
      firing = false;
    }
  };
  btn.addEventListener('pointerup', activate);
  btn.addEventListener('click', activate);
}

const NUDGE_DISMISS_KEY = 'auxilio.dismissedNudges';
const BELL_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>`;
const NUDGE_X_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

/**
 * In-page nudge banner (sync-driven). Shows the soonest visitor event the user
 * saved but hasn't acted on. "Manage" opens the panel AND navigates this tab to
 * the event — one click opens both. Dismissals persist in storage.session.
 */
function mountNudge() {
  const host = document.createElement('div');
  // pointer-events:none so the (always-present) host box doesn't swallow clicks on the
  // Calendar UI beneath it while the banner is hidden — the banner is display:flex even
  // when invisible, so the host keeps a box at top-center. `.banner.show{pointer-events:auto}`
  // restores hits when it's actually shown.
  host.style.cssText =
    'position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .banner {
        display:flex;align-items:center;gap:12px;max-width:520px;
        font-family:'Google Sans','Roboto',system-ui,sans-serif;color:#310031;
        background:#f8d9f5;border:1px solid #92288e33;border-radius:14px;
        padding:10px 12px 10px 16px;box-shadow:0 4px 12px rgba(0,0,0,.18);
        transform:translateY(-12px);opacity:0;pointer-events:none;
        transition:opacity 200ms cubic-bezier(.2,0,0,1),transform 200ms cubic-bezier(.2,0,0,1);
      }
      .banner.show{opacity:1;transform:none;pointer-events:auto;}
      .icon{display:inline-flex;color:#92288e;flex:0 0 auto;align-self:flex-start;margin-top:1px;}
      .text{display:flex;flex-direction:column;gap:1px;min-width:0;}
      /* Event name is the hero: prominent, ellipsised; the action reads as the subtitle. */
      .title{font-size:14.5px;font-weight:600;line-height:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .sub{font-size:12px;line-height:15px;opacity:.7;}
      .actions{display:flex;align-items:center;gap:4px;flex:0 0 auto;align-self:center;}
      .manage{font:inherit;font-size:13px;font-weight:600;color:#fff;background:#92288e;
        border:none;border-radius:999px;padding:8px 14px;cursor:pointer;}
      .manage:hover{box-shadow:0 2px 6px rgba(0,0,0,.2);}
      .dismiss{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;
        border:none;border-radius:50%;background:transparent;color:#5f5560;cursor:pointer;}
      .dismiss:hover{background:#0000000f;}
      @media (prefers-reduced-motion: reduce){.banner{transition:none;transform:none;}}
    </style>
    <div class="banner">
      <span class="icon">${BELL_SVG}</span>
      <span class="text">
        <span class="title"></span>
        <span class="sub"></span>
      </span>
      <span class="actions">
        <button class="manage" type="button">Manage</button>
        <button class="dismiss" type="button" aria-label="Dismiss">${NUDGE_X_SVG}</button>
      </span>
    </div>`;
  const wrap = root.querySelector('.banner') as HTMLDivElement;
  const titleEl = root.querySelector('.title') as HTMLSpanElement;
  const subEl = root.querySelector('.sub') as HTMLSpanElement;
  const manageBtn = root.querySelector('.manage') as HTMLButtonElement;
  const dismissBtn = root.querySelector('.dismiss') as HTMLButtonElement;
  shieldInteractions(host);

  let targets: VisitorEventSummary[] = [];
  // Optimistic, DOM-derived targets shown INSTANTLY (no API wait) for an event
  // the user just interacted with; the API sync reconciles them by eventId.
  const optimistic = new Map<string, VisitorEventSummary>();
  // Each optimistic guess is provisional: if the sync never confirms it as a
  // real visitor event (e.g. the event was deleted, already handled, or the
  // magic address removed), it self-expires rather than lingering forever.
  const optimisticTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const OPTIMISTIC_TTL = 12_000;
  const dropOptimistic = (eventId: string) => {
    const timer = optimisticTimers.get(eventId);
    if (timer) clearTimeout(timer);
    optimisticTimers.delete(eventId);
    optimistic.delete(eventId);
  };
  let panelOpen = false;
  let dismissed = new Set<string>();
  let current: VisitorEventSummary | null = null;

  safeStorageGet(NUDGE_DISMISS_KEY).then((r) => {
    dismissed = new Set((r[NUDGE_DISMISS_KEY] as string[]) ?? []);
    render();
  });

  /** Merged, deduped, soonest-first (synced target wins over optimistic). */
  function merged(): VisitorEventSummary[] {
    const byId = new Map<string, VisitorEventSummary>();
    for (const o of optimistic.values()) byId.set(o.eventId, o);
    for (const t of targets) byId.set(t.eventId, t); // synced data wins
    return [...byId.values()].sort((a, b) =>
      (a.start ?? '~').localeCompare(b.start ?? '~'),
    );
  }

  function visible(): VisitorEventSummary | null {
    return merged().find((t) => !dismissed.has(t.eventId)) ?? null;
  }

  function render() {
    const t = panelOpen ? null : visible();
    current = t;
    if (!t) {
      wrap.classList.remove('show');
      return;
    }
    const more = merged().filter((x) => !dismissed.has(x.eventId)).length - 1;
    // Event name is the hero (title row); the "needs passes" prompt is the subtitle.
    // Fall back to a generic title only when we genuinely have no event name.
    const name = t.title?.trim();
    titleEl.textContent = name || 'Visitor event';
    subEl.textContent =
      'Needs visitor passes' + (more > 0 ? ` · +${more} more` : '');
    wrap.classList.add('show');
  }

  // Use pointerup (not click): the host's capture-phase shield — which stops our
  // interactions from dismissing Google's modal — would otherwise swallow click.
  manageBtn.addEventListener('pointerup', () => {
    if (!current) return;
    const target = current;
    manageBtn.disabled = true;
    manageBtn.textContent = 'Opening…';
    // Engaging with the event clears its nudge for the session, so it doesn't
    // reappear when the panel closes (or when the optimistic re-add fires).
    dismissed.add(target.eventId);
    safeStorageSet({ [NUDGE_DISMISS_KEY]: [...dismissed] });
    render(); // hide the banner now
    // Set the active event FIRST (storage.session, now content-accessible) so the
    // panel has it the moment it mounts — no dependence on message ordering.
    safeStorageSet({ [ACTIVE_EID_KEY]: target.eid, [ACTIVE_SNAPSHOT_KEY]: null });
    // Open the panel within this gesture. We don't navigate the tab — the panel
    // resolves the event on its own; "Open in Calendar" there is the explicit way
    // to jump to it.
    safeSend({ type: 'OPEN_FOR_EVENT', eid: target.eid }).finally(() => {
      manageBtn.disabled = false;
      manageBtn.textContent = 'Manage';
    });
  });

  dismissBtn.addEventListener('pointerup', () => {
    if (!current) return;
    dismissed.add(current.eventId);
    safeStorageSet({ [NUDGE_DISMISS_KEY]: [...dismissed] });
    render();
  });

  return {
    setTargets(next: VisitorEventSummary[], cancelled: string[] = []) {
      targets = next ?? [];
      // The sync authoritatively resolved these away (deleted/cancelled/no
      // longer a visitor event) → purge any optimistic guess so a deleted
      // event can't keep nudging (or reopen the panel for a ghost event).
      for (const id of cancelled) dropOptimistic(id);
      // Drop optimistic entries the real sync now covers.
      for (const t of targets) dropOptimistic(t.eventId);
      render();
    },
    addOptimistic(s: VisitorEventSummary) {
      optimistic.set(s.eventId, s);
      const existing = optimisticTimers.get(s.eventId);
      if (existing) clearTimeout(existing);
      optimisticTimers.set(
        s.eventId,
        setTimeout(() => {
          optimistic.delete(s.eventId);
          optimisticTimers.delete(s.eventId);
          render();
        }, OPTIMISTIC_TTL),
      );
      render();
    },
    setPanelOpen(open: boolean) {
      panelOpen = open;
      render();
    },
  };
}

function escapeText(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

const PLUG_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/>
  <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>`;

/**
 * In-page reconnect banner: shown when the background reports a recoverable auth
 * lapse (the user was connected but a silent token renew failed). Without it the
 * whole nudge mechanism goes dark silently. "Reconnect" opens the side panel onto
 * the sign-in gate. Hidden while the panel is open (the gate is right there).
 */
function mountReconnect(onReconnect: () => void) {
  const host = document.createElement('div');
  // Sits just below the nudge banner's slot; pointer-events:none while hidden so
  // it never swallows clicks on the Calendar UI beneath it.
  host.style.cssText =
    'position:fixed;top:120px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .banner {
        display:flex;align-items:center;gap:12px;max-width:520px;
        font-family:'Google Sans','Roboto',system-ui,sans-serif;color:#410002;
        background:#fcdad6;border:1px solid #b3261e33;border-radius:14px;
        padding:10px 12px 10px 16px;box-shadow:0 4px 12px rgba(0,0,0,.18);
        transform:translateY(-12px);opacity:0;pointer-events:none;
        transition:opacity 200ms cubic-bezier(.2,0,0,1),transform 200ms cubic-bezier(.2,0,0,1);
      }
      .banner.show{opacity:1;transform:none;pointer-events:auto;}
      .icon{display:inline-flex;color:#b3261e;flex:0 0 auto;}
      .text{font-size:13.5px;line-height:18px;}
      .text b{font-weight:600;}
      .reconnect{font:inherit;font-size:13px;font-weight:600;color:#fff;background:#b3261e;
        border:none;border-radius:999px;padding:8px 14px;cursor:pointer;flex:0 0 auto;}
      .reconnect:hover{box-shadow:0 2px 6px rgba(0,0,0,.2);}
      @media (prefers-reduced-motion: reduce){.banner{transition:none;transform:none;}}
    </style>
    <div class="banner">
      <span class="icon">${PLUG_SVG}</span>
      <span class="text"><b>Auxilio needs to reconnect.</b> Visitor nudges are paused until you sign in again.</span>
      <button class="reconnect" type="button">Reconnect</button>
    </div>`;
  const wrap = root.querySelector('.banner') as HTMLDivElement;
  const btn = root.querySelector('.reconnect') as HTMLButtonElement;
  shieldInteractions(host);

  let lapsed = false;
  let panelOpen = false;
  function render() {
    wrap.classList.toggle('show', lapsed && !panelOpen);
  }

  // pointerup (not click): the host's capture-phase shield would swallow click.
  btn.addEventListener('pointerup', () => {
    btn.disabled = true;
    btn.textContent = 'Opening…';
    Promise.resolve(onReconnect()).finally(() => {
      btn.disabled = false;
      btn.textContent = 'Reconnect';
    });
  });

  return {
    setLapsed(v: boolean) {
      lapsed = v;
      render();
    },
    setPanelOpen(open: boolean) {
      panelOpen = open;
      render();
    },
  };
}
