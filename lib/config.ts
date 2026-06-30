/**
 * Central config. Values come from build-time env (see .env.example) with
 * safe dev defaults so the extension runs out of the box.
 */

export const ENGINE_BASE_URL = (
  import.meta.env.WXT_ENGINE_URL ??
  'https://ops-engine-dev-330299.bifrost.saastack.site'
).replace(/\/$/, '');

/** Web OAuth client id for chrome.identity.launchWebAuthFlow. Must also be on
 *  the engine's AUXILIO_WORKSPACE_OAUTH_CLIENT_ID audience allow-list. */
export const OAUTH_CLIENT_ID = import.meta.env.WXT_OAUTH_CLIENT_ID ?? '';

/** Marker that makes an event a "visitor event" (Phase 2). Lower-cased for
 *  case-insensitive matching against attendee emails / location text. */
export const MAGIC_ADDRESS = (
  import.meta.env.WXT_MAGIC_ADDRESS ?? 'visitors@auxilio.app'
).toLowerCase();

/** All engine addon endpoints live under this prefix. */
export const ADDON_API = `${ENGINE_BASE_URL}/api/visitor/calendar/addon`;

/** Verbose diagnostic logging gate. On in dev; off in production unless forced with
 *  WXT_DEBUG=1. The steady-state diagnostics (per-minute sync log, per-render roster
 *  log, the per-event payload stringify) cost CPU and can pin objects (defeating GC)
 *  in a long-lived Calendar tab, so production ships quiet. Errors/warnings are NOT
 *  gated by this — only the chatty informational logs. */
export const DEBUG =
  import.meta.env.WXT_DEBUG === '1' ||
  import.meta.env.WXT_DEBUG === 'true' ||
  !!import.meta.env.DEV;
