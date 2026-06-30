# Performance & Resource Audit — `auxilio-extension`

- **Version audited:** 0.14.1
- **Date:** 2026-06-30
- **Scope:** content script (`entrypoints/calendar.content.ts`), MV3 service worker
  (`entrypoints/background.ts`), sync engine (`lib/calendar-sync.ts`, `lib/calendar.ts`),
  auth/people libs, side-panel React app (`features/visit/*`, `lib/*`).

Goal: find performance issues, memory leaks, and anything that can cause excess
system-resource consumption, slowdown, or a crash of the browser / webpage / extension.

---

## Summary

The code is defensively written: sync coalescing, burst caps, throttles, a bounded
90-day window, TTL'd caches, and orphaned-context guards. There is **no catastrophic
leak or runaway loop**.

There are, however, a handful of real, fixable hot paths. The most important (full-page
`innerText` on a recurring timer) will cause noticeable jank on the low-end Android-class
hardware the project constraints target. Most findings are in the content script, because
it runs inside Google Calendar — a heavy, constantly-mutating SPA.

None of these are correctness bugs, so they can ship as a single "performance pass" patch.

---

## Status — resolved in 0.14.2

The high-value set has been implemented (type-check + prod build clean; the prod build
constant-folds the new `DEBUG` flag to `false` and tree-shakes every gated log):

- **H1 — fixed.** `snapshotOf` now reads `textContent` (no forced reflow), and the
  `document.body` surface is scoped to `[role="main"]` so it reads the event form, not the
  whole app shell.
- **M2 — fixed.** The 1 Hz `editorPoll` early-returns on `document.hidden`; the
  `visibilitychange` listener repaints immediately on return.
- **M3 — fixed.** The per-event `JSON.stringify` payload diagnostic is gated behind `DEBUG`.
- **M4 — fixed.** Per-minute "sync done" log, the per-render roster log in
  `useResolveGuestNames`, and the two `events.get` object-logs are gated/removed. Errors
  and warnings are left intact.
- **L9 — fixed.** Deleted `scrollContainer`, `mainVerticalList`, `stacksVertically`,
  `shieldPadding`.

New build flag: `WXT_DEBUG=1` forces the verbose diagnostics back on in a production build
(they're always on in `npm run dev`). See `lib/config.ts` `DEBUG`.

Still open (opportunistic): **M5, L6, L7, L8, L10**.

---

## HIGH severity

### H1 — Full-page `document.body.innerText` on a recurring timer while editing an event
**File:** `entrypoints/calendar.content.ts`

- `readSurface()` returns `{ el: document.body, eid }` for the URL-eid case and the
  full-screen editor case (`calendar.content.ts:282`, `:287`).
- `render()` then calls `snapshotOf(surface.el, …)` (`:322`), which runs
  `const text = el.innerText || '';` (`:292`), then `extractEmails(text)` and
  `text.toLowerCase()` over the **entire page's rendered text**.
- `render()` is driven by:
  - the **1-second `setInterval`** safety net (`:209–220`), unconditionally, and
  - the MutationObserver's 150 ms debounce (`:435`), which fires constantly while typing.

`HTMLElement.innerText` (unlike `textContent`) **forces a synchronous reflow** and is
O(size of the rendered subtree). Running it against `document.body` of the Calendar editor
at least once per second — more while typing — is the single most expensive repeated
operation in the extension. On a mid/low-end device this produces visible typing jank.

**Fix direction:** when the surface element is `document.body`, scope the snapshot to the
actual event form/dialog subtree (already locatable via `isEventDialog`/`findContentList`).
At minimum switch the email scrape to `textContent` (no forced layout) and/or compute the
snapshot only when the eid actually changed, not on every poll tick.

---

## MEDIUM severity

### M2 — Perpetual 1 Hz `setInterval(render, 1000)` for the entire tab lifetime
**File:** `calendar.content.ts:209–220`

The editor poll never stops (only on orphan teardown). Even when no event is open and the
tab is backgrounded, it wakes every second → `render()` → `readSurface()` →
`document.querySelectorAll('[role="dialog"]')` + `filter(isVisible)` (each `isVisible`
calls `getClientRects()`, a layout read). Cheap per tick when idle, but forever, on every
open Calendar tab, and it compounds H1 when a surface is open.

**Fix direction:** pause on `document.hidden` (a `visibilitychange` listener already
exists) and/or back off to a slower cadence when no surface has been seen recently.

### M3 — `JSON.stringify(ev)` per non-marked event on every sync (diagnostic in the hot loop)
**File:** `lib/calendar-sync.ts:267`

```js
if (!hasMagic && MAGIC_ADDRESS && JSON.stringify(ev).toLowerCase().includes(MAGIC_ADDRESS)) {
```

Serializes **every event object that isn't already matched**, on every sync pass.
Incremental syncs are small, but the 12-hour full re-scan and the install re-scan walk the
whole 90-day window (hundreds of events), stringifying each one purely for a diagnostic
warning.

**Fix direction:** gate behind a debug flag, or check the few concrete fields
(`description`, raw attendee list) instead of stringifying the whole object.

### M4 — Verbose `console.*` logging in steady-state hot paths
- `lib/calendar-sync.ts:357` logs `"sync done"` **every minute, forever** (alarm cadence).
- `entrypoints/background.ts` has 12 log statements incl. per-event-resolve and orphan-cancel.
- `lib/calendar.ts` logs every `events.get` candidate attempt.
- `features/visit/hooks.ts:133` — `useResolveGuestNames` calls `console.log(...)` at
  **component-body level** (not inside a `useEffect`), mapping the full roster into a new
  array on **every render of `VisitPanel`**.

Production logging isn't free: it allocates, is synchronous, and **retained log arguments
can pin objects and defeat GC** (worse with DevTools open). The hooks log also allocates a
fresh mapped array every render.

**Fix direction:** add a `DEBUG` build-flag gate so production ships quiet; move the hooks
log into the effect if kept at all.

### M5 — MutationObserver on the whole `document.body` subtree, with a forced-layout read per batch
**File:** `calendar.content.ts:427–442`

Watching `document.body` with `{ childList: true, subtree: true }` for the page lifetime is
unavoidable (the button can mount anywhere) and well-mitigated — `keepAlive()` early-returns
when no surface is shown (`:770`). Remaining cost: when a surface **is** shown, every
mutation batch runs `keepAlive()` → `isVisible(el)` → `getClientRects()` (`:772`), a layout
read, regardless of *what* mutated. Google's ~750-mutation first-open reconciliation storm
therefore triggers many forced layout reads. `BURST_CAP` (`:1355`) guards the insert path
but not this per-mutation read.

**Fix direction:** cache visibility within a frame; low urgency.

---

## LOW severity

### L6 — `seenEventPopovers` grows unbounded
**File:** `calendar.content.ts:1147` — a `Set<string>` of every event id ever opened in the
tab session; entries are never evicted. On a long-lived Calendar tab (often open for days),
opening many events grows it without bound. Small per-entry, but a genuine slow leak.
**Fix:** cap it (LRU / max size) or clear periodically.

### L7 — Fragile O(DOM) fallback scan repeated up to 30× in the placement retry
`findAvailabilityInfo()` (`:834–842`) short-circuits on the stable `[jsname="g7cnnb"]` hook,
but its fallback iterates **every `<span>` and `<div>`** calling `isVisible()` on each. The
inline-placement retry loop (`:741–753`) calls `findAnchor → findAvailabilityInfo` up to 30
times over ~4.5 s, and `render()` restarts that loop each second. If Google ever changes
that `jsname`, this degrades to a full-DOM `getClientRects` scan repeated dozens of times
per second — a latent cliff. **Fix:** add a cheaper guard or cap the fallback scan.

### L8 — Every click anywhere on the page schedules 3 renders
`calendar.content.ts:396–412` — the capture-phase document click handler fires
`for (const d of [60,250,600]) setTimeout(render, d)` on **any** click, not just event-chip
clicks. Each `render()` is a `readSurface()` pass. **Fix:** only schedule the probe burst
when the click actually hit a `[data-eventid]` chip (already computed as `chip`).

### L9 — Dead code carrying the worst O(n) patterns
Confirmed unused (zero callers): `scrollContainer` (`:968`), `mainVerticalList` (`:927`),
and transitively `stacksVertically` (`:873`) and `shieldPadding` (`:1458`).
`scrollContainer`/`mainVerticalList` both do `root.querySelectorAll('*')` then
`getComputedStyle`/`getBoundingClientRect` per element — never executed, but pure bundle
weight shipped to every Calendar tab. **Fix:** delete them.

### L10 — Orphan teardown doesn't detach document/window listeners
`teardown()` (`:227–233`) disconnects the observer and clears the interval but leaves the
`click`/`keydown`/`focus`/`visibilitychange`/`popstate`/`chrome.runtime.onMessage` listeners
attached, retaining the whole closure (button, nudge, reconnect hosts) until the next
instance's startup cleanup runs. Short-lived (a new instance is injected on update and
cleans `[data-auxilio]` nodes), so minor. **Fix:** `removeEventListener` and remove shadow
hosts in teardown for completeness.

---

## Correctly handled (no action needed)

- **Sync concurrency** coalesced via the `inFlight` promise (`calendar-sync.ts:191–198`).
- **Forward window bounded** to 90 days, `maxResults=250` pagination (`lib/calendar.ts:18`,
  `:225`) — explicitly avoids the 6000-row/14 s scan that could be killed mid-flight.
- **Engine status polling throttled** to 5 min and signature-gated (`background.ts:183–206`).
- **People cache** TTL'd, negatively-cached briefly, version-busted, capped at
  `CACHE_MAX=1000` (`lib/people.ts`).
- **`handled`/`marked` maps pruned** by grace/TTL each sync (`calendar-sync.ts:339–353`).
- **Side-panel React** cleans up all `storage.onChanged` and `runtime.onMessage` listeners
  in effect returns; `useResolveGuestNames` uses a `cancelled` flag. QueryClient has sane
  `staleTime`/`retry`; the panel is short-lived.
- **Orphaned-context guards** (`extAlive`, `safeSend`) prevent throw-storms after reload.

---

## Recommended priority order

1. **H1** — scope the snapshot off `document.body` / use `textContent` / only on eid change.
   (Biggest real-world win; directly hits the low-end-device constraint.)
2. **M2 + M4** — pause the 1 Hz poll when hidden; gate production logging.
3. **M3** — drop the per-event `JSON.stringify` diagnostic from the sync loop.
4. **L9** — delete dead code.
5. **L6, L7, L8, L10, M5** — opportunistic hardening.
