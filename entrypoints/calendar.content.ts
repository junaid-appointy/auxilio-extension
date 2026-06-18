/**
 * Content script on Google Calendar — a *dumb trigger* only. It detects when an
 * event is open (by reading the `eid` from the URL, not scraping Google's DOM)
 * and shows a style-isolated "Register a visitor" button. Clicking it asks the
 * background worker to resolve the event and open the side panel. No tokens, no
 * business logic here. (Phase 2 adds the magic-address banner.)
 */
import { MAGIC_ADDRESS } from '@/lib/config'; // reserved for Phase 2

const PRIMARY = '#92288e';

export default defineContentScript({
  matches: ['https://calendar.google.com/*'],
  main() {
    void MAGIC_ADDRESS; // referenced in Phase 2; keep the import wired
    const ui = mountTrigger();
    let lastEid: string | null = null;

    const sync = () => {
      const eid = currentEid();
      if (eid === lastEid) return;
      lastEid = eid;
      ui.setEid(eid);
    };

    sync();
    // Calendar is an SPA; poll the URL (cheap) instead of coupling to its DOM.
    setInterval(sync, 700);
    window.addEventListener('popstate', sync);

    console.log('[auxilio] content script ready on Google Calendar');
  },
});

/** Extract the Google Calendar event id from the current URL, if an event is open. */
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

const USER_PLUS_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
  <circle cx="9" cy="7" r="4"/>
  <line x1="19" x2="19" y1="8" y2="14"/>
  <line x1="22" x2="16" y1="11" y2="11"/>
</svg>`;

/** Inject a shadow-DOM floating button. Returns a handle to toggle visibility. */
function mountTrigger() {
  const host = document.createElement('div');
  host.id = 'auxilio-trigger-host';
  host.style.cssText =
    'position:fixed;right:24px;bottom:24px;z-index:2147483646;';
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .fab {
        display: inline-flex; align-items: center; gap: 8px;
        font-family: 'Google Sans','Roboto',system-ui,sans-serif;
        font-size: 14px; font-weight: 600; letter-spacing: .1px;
        color: #fff; background: ${PRIMARY};
        border: none; border-radius: 999px; padding: 12px 18px;
        box-shadow: 0 2px 6px rgba(0,0,0,.18); cursor: pointer;
        transform: translateY(8px); opacity: 0; pointer-events: none;
        transition: opacity 200ms cubic-bezier(.2,0,0,1),
                    transform 200ms cubic-bezier(.2,0,0,1),
                    box-shadow 120ms ease;
      }
      .fab.show { opacity: 1; transform: none; pointer-events: auto; }
      .fab:hover { box-shadow: 0 4px 12px rgba(0,0,0,.24); }
      .fab:active { transform: scale(.98); }
      .fab[disabled] { opacity: .6; pointer-events: none; }
      @media (prefers-reduced-motion: reduce) {
        .fab { transition: none; transform: none; }
      }
    </style>
    <button class="fab" type="button" part="fab">
      ${USER_PLUS_SVG}<span class="label">Register a visitor</span>
    </button>`;

  const btn = root.querySelector('button.fab') as HTMLButtonElement;
  const label = root.querySelector('.label') as HTMLSpanElement;
  let eid: string | null = null;

  btn.addEventListener('click', async () => {
    if (!eid) return;
    btn.disabled = true;
    label.textContent = 'Opening…';
    try {
      await chrome.runtime.sendMessage({ type: 'OPEN_FOR_EVENT', eid });
    } catch (err) {
      console.error('[auxilio] open failed', err);
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
