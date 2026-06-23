# auxilio-extension

Google **Chrome extension (MV3)** for Auxilio (Office Ops) — the **desktop** surface for registering office visitors directly inside Google Calendar. It is the richer counterpart to the `auxilio-workspace` Calendar add-on: where the add-on is mobile-capable but lives under the CardService "card ceiling," the extension gives a full React UI (realtime guest updates, per-guest invite toggle, template preview, inline edits, intentional auto-nudge).

> Read the umbrella `../CLAUDE.md` for the four constraints and UX rules — they apply here.
> Strategy + approval analysis: `../Planning-docs/2026-06-18_calendar_visitor_chrome_extension_decision.md`.
> Build plan: the approved plan that scaffolded this repo.

## What this is (and isn't)

- **Is:** an MV3 extension (WXT + React 19 + TS) that injects a trigger into Google Calendar (web) and renders the registration flow in the **side panel**. A **channel surface / dumb adapter** — it forwards intent to `office-ops-engine`.
- **Isn't:** a place for business logic. Dedup, draft curation, invite/pass issuance, and lifecycle all live in `office-ops-engine`'s visitor plugin. This repo renders UI and calls the engine.
- **Isn't:** mobile. Extensions are desktop-Chrome only. The `auxilio-workspace` add-on remains the mobile surface. Both key off the same **magic address**.

## Architecture — three MV3 surfaces

- **`entrypoints/background.ts`** (service worker) — the only holder of tokens + network. Mints/caches the Google `id_token` (engine auth) + `access_token` (Calendar read), runs the Calendar API client and the engine `/addon/*` client, keeps per-tab event context, routes messages.
- **`entrypoints/calendar.content.ts`** (content script @ `calendar.google.com`) — a **dumb trigger/observer**: detect open event, decode `eid`, inject the "Register a visitor" button (Phase 1) and the magic-address banner (Phase 2). No tokens, no business logic.
- **`entrypoints/sidepanel/`** (the app) — React + TanStack Query UI. Pure presentation + server state.

```
content script ──msg──> background ──HTTPS(id_token)──> office-ops-engine /api/visitor/calendar/addon/*
side panel    ──msg──> background ──Calendar API(access_token)──> canonical iCalUID + attendees
```

## Hard rules

1. **Calendar-only scopes. Never add Gmail/Drive.** Calendar is *sensitive* (verification, no paid audit). Gmail/Drive are *restricted* → annual CASA assessment. Hard line, same as the add-on.
2. **Engine owns the contract.** The extension calls the existing `/api/visitor/calendar/addon/{draft,preview,send,cancel-guest}` routes (ID-token authed). Do **not** add engine signature/scope changes from here. The only engine-side change is env: add this extension's OAuth client id to `AUXILIO_WORKSPACE_OAUTH_CLIENT_ID` (audience allow-list).
3. **Background is the only secret/network holder.** Content script stays a dumb trigger; side panel stays presentation. Keep the thin-adapter boundary.
4. **Send the canonical `iCalUID`** (from the Calendar API `events.get`, not synthesized) so the extension path converges on the same `calendar_event_links` row as `.ics`/OAuth/add-on.
5. **Design: Material 3 tokens, not its code.** Our own `design/tokens.ts` + `global.css` (primary `#92288E`). No MUI/Tailwind/paper. **Icons: lucide-react only**, no Unicode glyphs/emoji in chrome.
6. **Animations subtle, only where needed** — CSS transitions driven by motion tokens; respect `prefers-reduced-motion`.
7. **Internal-first.** Force-installed/unlisted to our Workspace → no OAuth verification yet. Public/commercial = a later packaging + verification exercise (CWS review + OAuth verification), per the decision doc.

## Stack & commands

WXT (MV3 over Vite) + React 19 + TypeScript + TanStack Query (server state) + Zustand (UI/session/event-context) + lucide-react.

```bash
npm install
npm run dev        # WXT dev server; load .output/chrome-mv3 in chrome://extensions (Developer mode → Load unpacked)
npm run build      # production build → .output/chrome-mv3
npm run compile    # tsc --noEmit (type-check)
npm run zip        # packaged zip for store upload
```

Env: copy `.env.example` → `.env` (engine URL, OAuth client id, magic address). `WXT_` vars are inlined at build.

## Versioning

**Bump `package.json` `version` on every change you ship to the browser.** WXT syncs it into `manifest.json` automatically, so `chrome://extensions` shows the loaded build's version. This is the check that a reload actually picked up your change — if the card's version doesn't match what you just built, the old bundle is still loaded (reload there and reopen the side panel). Use semver: patch for fixes, minor for features.

## Deploy / distribution

**Not Bifrost, not EAS.** Internal-first via Chrome admin **force-install** (unlisted, by extension id) or "Load unpacked" for dev. Public later via the Chrome Web Store (payments handled by our own engine; CWS no longer bills).
