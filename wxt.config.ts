import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
// Manifest is intentionally minimal and Calendar-only (no Gmail/Drive — CASA line).
// Auth uses chrome.identity.launchWebAuthFlow (web OAuth client), so no `oauth2`
// manifest key is needed; the client id is read from env in lib/config.ts.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Auxilio Visitor',
    description:
      'Register office visitors directly from a Google Calendar event.',
    permissions: ['identity', 'sidePanel', 'storage', 'alarms', 'notifications'],
    host_permissions: [
      'https://calendar.google.com/*',
      'https://www.googleapis.com/*',
      'https://ops-engine-dev-330299.bifrost.saastack.site/*',
    ],
    // Toolbar icon; background flips openPanelOnActionClick so a click opens the panel.
    action: { default_title: 'Auxilio Visitor' },
  },
});
