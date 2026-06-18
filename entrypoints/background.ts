export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel (the user gesture Chrome
  // requires). Per-event auto-surfacing (Option A) is wired in Phase 2 via the
  // content script's banner, which also opens the panel from a user click.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[auxilio] setPanelBehavior failed', err));

  console.log('[auxilio] background ready');
});
