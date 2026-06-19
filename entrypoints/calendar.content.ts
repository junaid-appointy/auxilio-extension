/**
 * Content script on Google Calendar — the ONE contained DOM dependency.
 *
 * Robustness contract (Option B): the only thing we read from Google's DOM is
 * the `data-eventid` attribute on a clicked event chip — a long-standing
 * *semantic* attribute (base64url of "<eventId> <calendarId>"), not a layout/CSS
 * class. Everything else (change detection, the visitor nudge, badge) is done by
 * the background via the Calendar API sync token — no DOM. If `data-eventid`
 * ever disappears, we log it and the side panel's "open from list" fallback
 * still works.
 */
export default defineContentScript({
  matches: ['https://calendar.google.com/*'],
  main() {
    let eid: string | null = null;
    let everSawEventId = false;

    const fab = mountFab((e) => openFor(e));

    function setEid(next: string | null) {
      if (next === eid) return;
      eid = next;
      fab.setEid(eid);
    }

    // Primary trigger: the clicked event chip carries the event id as
    // `data-eventid`. Works for the popover, where the URL has no eid.
    document.addEventListener(
      'click',
      (e) => {
        const chip = (e.target as Element | null)?.closest?.('[data-eventid]');
        const id = chip?.getAttribute('data-eventid');
        if (id) {
          everSawEventId = true;
          setEid(id);
        }
      },
      true,
    );

    // Escape closes the popover/editor → drop the active event.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') setEid(null);
      },
      true,
    );

    // Fallback: some Calendars still expose the eid in the URL.
    let lastUrlEid: string | null = null;
    setInterval(() => {
      const u = currentEid();
      if (u && u !== lastUrlEid) {
        lastUrlEid = u;
        setEid(u);
      }
    }, 1000);
    window.addEventListener('popstate', () => {
      const u = currentEid();
      if (u) setEid(u);
    });

    // Graceful-degradation telemetry: if Google ever drops `data-eventid`, this
    // surfaces it instead of failing silently. The panel's list view still works.
    setTimeout(() => {
      if (!everSawEventId && !document.querySelector('[data-eventid]')) {
        console.warn(
          '[auxilio] no [data-eventid] found — click detection may be unavailable; use the panel’s event list.',
        );
      }
    }, 90_000);

    console.log('[auxilio] content script ready on Google Calendar');
  },
});

function openFor(eid: string) {
  return chrome.runtime
    .sendMessage({ type: 'OPEN_FOR_EVENT', eid })
    .catch((err) => console.error('[auxilio] open failed', err));
}

/** Fallback only: extract the event id from the URL, if present. */
function currentEid(): string | null {
  const path = location.pathname.match(/\/eventedit\/([^/?#]+)/);
  if (path && path[1] !== 'eventedit') return safeDecode(path[1]);
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
  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
  <line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>`;

/** Floating "Register a visitor" button, shown for the clicked event. */
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
    <button class="fab" type="button">${USER_PLUS_SVG}<span class="label">Register a visitor</span></button>`;
  const btn = root.querySelector('button') as HTMLButtonElement;
  const label = root.querySelector('.label') as HTMLSpanElement;
  let current: string | null = null;
  btn.addEventListener('click', async () => {
    if (!current) return;
    btn.disabled = true;
    label.textContent = 'Opening…';
    try {
      await onClick(current);
    } finally {
      btn.disabled = false;
      label.textContent = 'Register a visitor';
    }
  });
  return {
    setEid(next: string | null) {
      current = next;
      btn.classList.toggle('show', !!next);
    },
  };
}
