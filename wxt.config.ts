import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

// WXT inlines import.meta.env (the baked engine URL in lib/config.ts) from .env,
// but does NOT populate process.env — which this config reads to build the engine
// host_permission. Load WXT_ENGINE_URL from .env here so host_permission always
// matches the URL baked into the bundle. An inline `env WXT_ENGINE_URL=… ` still
// wins (we only fill when it's unset).
if (!process.env.WXT_ENGINE_URL) {
  try {
    const m = readFileSync(new URL('.env', import.meta.url), 'utf8')
      .match(/^\s*WXT_ENGINE_URL\s*=\s*(.+?)\s*$/m);
    if (m) process.env.WXT_ENGINE_URL = m[1].trim();
  } catch { /* no .env — fall back to the default below */ }
}

// Engine host_permission is derived from the build-time engine URL so the
// published manifest only ever carries the engine it actually targets (no stale
// tunnel hosts). Prod: pass WXT_ENGINE_URL=<bifrost url>. Local dev against the
// reserved tunnel: WXT_ENGINE_URL=<ngrok url> npm run dev. Falls back to the
// deployed bifrost dev engine when unset.
const ENGINE_URL = (
  process.env.WXT_ENGINE_URL ?? 'https://ops-engine-dev-330299.bifrost.saastack.site'
).replace(/\/$/, '');
const ENGINE_HOST = `${new URL(ENGINE_URL).origin}/*`;

// Store builds must NOT ship our self-generated `key`: the Chrome Web Store
// assigns the item its own key/ID on first upload, and a mismatching key is
// rejected ("key field value doesn't match the current item"). Omit it for store
// zips (WXT_STORE_BUILD=1); keep it for load-unpacked / self-distributed builds so
// their ID stays the stable `babflij…`.
const STORE_BUILD = process.env.WXT_STORE_BUILD === '1';

// Pinned public key → stable extension ID `babflijdehjlajekidajimhaggoceabn` on
// every install (load-unpacked on any machine), so the OAuth redirect URI
// `https://babflijdehjlajekidajimhaggoceabn.chromiumapp.org/` stays registered.
// The matching private key lives in key.pem (gitignored — keep it safe for
// packing/CWS). The public key below is NOT secret.
const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAntwr7hJGVN90yNPnKmqHfRwv0LT5CDfYBsI7dMZfZsuxc1Ua5khdrteHFSFbJ7ClNFbH2ERqvl+SgeAu55IeRH6XiUUHzklLwLk4nj4ip3ijH5FBfJrmdp8oTJTE4DIMZOu2bzJykFf4E6sk2FQ/XjGBKjTf2ks/mA59wH65CPPHiWdxbvhS4F+YAgP+aufWDGfIOld9pw9jfdSV45B1a8yHo36iOEMK290lE5afLcHGO0c7tvx11dH7R14O3DwEj81qsj9ZR81UBQswhH1nj8fS2V4ZusV5/73nZBMt7zQTjgIIBm8bmX4ao3fD+P++R9OAc87hoYM+dqmt59qTEwIDAQAB';

// See https://wxt.dev/api/config.html
// Manifest is intentionally minimal and Calendar-only (no Gmail/Drive — CASA line).
// Auth uses chrome.identity.launchWebAuthFlow (web OAuth client), so no `oauth2`
// manifest key is needed; the client id is read from env in lib/config.ts.
export default defineConfig({
  // Visible (non-dot) output dir so Chrome's "Load unpacked" picker and Finder
  // show it without toggling hidden files. Builds land in output/chrome-mv3,
  // dev in output/chrome-mv3-dev, zips in output/*.zip.
  outDir: 'output',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    // Included for load-unpacked (stable ID); omitted for store builds.
    ...(STORE_BUILD ? {} : { key: EXTENSION_KEY }),
    name: 'Auxilio Visitor',
    description:
      'Register office visitors directly from a Google Calendar event.',
    permissions: ['identity', 'sidePanel', 'storage', 'alarms', 'notifications'],
    host_permissions: [
      'https://calendar.google.com/*',
      'https://www.googleapis.com/*',
      // People API (guest name + photo resolution) lives on its own host.
      'https://people.googleapis.com/*',
      // Engine — derived from WXT_ENGINE_URL at build time.
      ENGINE_HOST,
    ],
    // Toolbar icon; background flips openPanelOnActionClick so a click opens the panel.
    action: {
      default_title: 'Auxilio Visitor',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
  },
});
