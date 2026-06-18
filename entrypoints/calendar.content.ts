/**
 * Content script on Google Calendar. It is a *dumb trigger/observer* only:
 * it detects when an event is open and (Phase 1) injects the "Register a
 * visitor" button / (Phase 2) the magic-address banner. It never holds tokens
 * or business logic — that lives in the background worker and the engine.
 */
export default defineContentScript({
  matches: ['https://calendar.google.com/*'],
  main() {
    console.log('[auxilio] content script ready on Google Calendar');
  },
});
