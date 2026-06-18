# Auxilio Visitor — Chrome Extension

Desktop Chrome surface for registering office visitors directly from a Google
Calendar event. The richer counterpart to the `auxilio-workspace` Calendar
add-on; both forward intent to `office-ops-engine`. See `CLAUDE.md` for the
architecture and rules.

## Quick start

```bash
npm install
cp .env.example .env     # set engine URL, OAuth client id, magic address
npm run dev              # then load .output/chrome-mv3 via chrome://extensions
```

1. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked** →
   `.output/chrome-mv3`.
2. Open [Google Calendar](https://calendar.google.com), open an event.
3. Click **Register a visitor** (Phase 1) or the toolbar icon to open the panel.

## Stack

WXT · React 19 · TypeScript · TanStack Query · Zustand · lucide-react · MD3 tokens.

## Status

- **Phase 0** — scaffold, theme, side-panel shell. ✅
- **Phase 1** — manual-invoke full flow (roster, toggles, edit, preview, send).
- **Phase 2** — magic-address auto-nudge (Option A banner).
