/**
 * Content script on Google Calendar — a *dumb trigger/observer* only. No tokens,
 * no business logic.
 *
 * - Detects an open event from the URL `eid` (not by scraping Google's layout).
 * - Detects the *magic address* (an attendee marking the event as a visitor
 *   event) by a cheap text scan — a TRIGGER signal only, never data-of-record.
 * - Marked event  → auto-injects the dismissible Option-A banner (the intentional
 *   nudge). Click → background resolves the event + opens the side panel.
 * - Unmarked event → the subtle "Register a visitor" FAB stays available.
 * - Guest-list mutations → debounced signal so the side panel refetches.
 */
import { MAGIC_ADDRESS } from '@/lib/config';
import { notifyEventTouched } from '@/lib/messaging';

const PRIMARY = '#92288e';

export default defineContentScript({
  matches: ['https://calendar.google.com/*'],
  main() {
    const dismissed = new Set<string>();
    let lastEid: string | null = null;

    const fab = mountFab((eid) => openFor(eid));
    const banner = mountBanner(
      (eid) => {
        banner.hide();
        openFor(eid);
      },
      (eid) => {
        dismissed.add(eid);
        banner.hide();
        fab.setEid(eid); // fall back to the subtle FAB after dismissal
      },
    );

    function render(fromMutation: boolean) {
      const eid = currentEid();
      if (!eid) {
        fab.setEid(null);
        banner.hide();
        return;
      }
      const marked = hasMagicAddress();
      if (marked && !dismissed.has(eid)) {
        fab.setEid(null);
        banner.show(eid);
      } else {
        banner.hide();
        fab.setEid(eid);
      }
      if (fromMutation) notifyEventTouched(eid);
    }

    // Cheap URL poll catches event open/close (SPA, no full reload).
    setInterval(() => {
      const eid = currentEid();
      if (eid !== lastEid) {
        lastEid = eid;
        render(false);
      }
    }, 700);
    window.addEventListener('popstate', () => render(false));

    // Debounced DOM observer: re-evaluate the marker + tell the panel to refetch
    // when the guest list changes.
    let timer: number | undefined;
    new MutationObserver(() => {
      if (!currentEid()) return;
      clearTimeout(timer);
      timer = setTimeout(() => render(true), 700) as unknown as number;
    }).observe(document.body, { childList: true, subtree: true });

    render(false);
    console.log('[auxilio] content script ready on Google Calendar');
  },
});

function openFor(eid: string) {
  return chrome.runtime
    .sendMessage({ type: 'OPEN_FOR_EVENT', eid })
    .catch((err) => console.error('[auxilio] open failed', err));
}

function currentEid(): string | null {
  const path = location.pathname.match(/\/eventedit\/([^/?#]+)/);
  if (path) return safeDecode(path[1]);
  const q = new URLSearchParams(location.search).get('eid');
  return q ? safeDecode(q) : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Trigger-only: is the magic address present anywhere in the open event view? */
function hasMagicAddress(): boolean {
  if (!MAGIC_ADDRESS) return false;
  const text = document.body?.innerText?.toLowerCase() ?? '';
  return text.includes(MAGIC_ADDRESS);
}

const USER_PLUS_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
  <line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>`;

const USER_CHECK_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
  <polyline points="16 11 18 13 22 9"/></svg>`;

const X_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

/** Floating "Register a visitor" button (subtle, always available). */
function mountFab(onClick: (eid: string) => void) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483646;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .fab {
        display:inline-flex;align-items:center;gap:8px;
        font-family:'Google Sans','Roboto',system-ui,sans-serif;font-size:14px;font-weight:600;
        color:#fff;background:${PRIMARY};border:none;border-radius:999px;padding:12px 18px;
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
    <button class="fab" type="button">${USER_PLUS_SVG}<span class="label">Register a visitor</span></button>`;
  const btn = root.querySelector('button') as HTMLButtonElement;
  const label = root.querySelector('.label') as HTMLSpanElement;
  let eid: string | null = null;
  btn.addEventListener('click', async () => {
    if (!eid) return;
    btn.disabled = true;
    label.textContent = 'Opening…';
    try {
      await onClick(eid);
    } finally {
      btn.disabled = false;
      label.textContent = 'Register a visitor';
    }
  });
  return {
    setEid(next: string | null) {
      eid = next;
      btn.classList.toggle('show', !!next);
    },
  };
}

/** Option-A banner: the intentional nudge for magic-address-marked events. */
function mountBanner(onRegister: (eid: string) => void, onDismiss: (eid: string) => void) {
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .banner {
        display:flex;align-items:center;gap:12px;
        font-family:'Google Sans','Roboto',system-ui,sans-serif;color:#310031;
        background:#f8d9f5;border:1px solid #92288e33;border-radius:14px;
        padding:10px 12px 10px 16px;box-shadow:0 4px 12px rgba(0,0,0,.18);max-width:480px;
        transform:translateY(-12px);opacity:0;pointer-events:none;
        transition:opacity 200ms cubic-bezier(.2,0,0,1),transform 200ms cubic-bezier(.2,0,0,1);
      }
      .banner.show{opacity:1;transform:none;pointer-events:auto;}
      .icon{display:inline-flex;color:${PRIMARY};flex:0 0 auto;}
      .text{font-size:13.5px;line-height:18px;}
      .text b{font-weight:600;}
      .actions{display:flex;align-items:center;gap:4px;flex:0 0 auto;}
      .register{
        font:inherit;font-size:13px;font-weight:600;color:#fff;background:${PRIMARY};
        border:none;border-radius:999px;padding:8px 14px;cursor:pointer;
      }
      .register:hover{box-shadow:0 2px 6px rgba(0,0,0,.2);}
      .dismiss{display:inline-flex;align-items:center;justify-content:center;
        width:30px;height:30px;border:none;border-radius:50%;background:transparent;
        color:#5f5560;cursor:pointer;}
      .dismiss:hover{background:#0000000f;}
      @media (prefers-reduced-motion: reduce){.banner{transition:none;transform:none;}}
    </style>
    <div class="banner">
      <span class="icon">${USER_CHECK_SVG}</span>
      <span class="text"><b>Visitor event.</b> Register your guests and send their passes.</span>
      <span class="actions">
        <button class="register" type="button">Register</button>
        <button class="dismiss" type="button" aria-label="Dismiss">${X_SVG}</button>
      </span>
    </div>`;
  const wrap = root.querySelector('.banner') as HTMLDivElement;
  const register = root.querySelector('.register') as HTMLButtonElement;
  const dismiss = root.querySelector('.dismiss') as HTMLButtonElement;
  let eid: string | null = null;
  register.addEventListener('click', () => eid && onRegister(eid));
  dismiss.addEventListener('click', () => eid && onDismiss(eid));
  return {
    show(next: string) {
      eid = next;
      wrap.classList.add('show');
    },
    hide() {
      wrap.classList.remove('show');
    },
  };
}
