/// <reference types="wxt/vite-builder-env" />

// Build-time env (WXT_ prefix is exposed to the extension runtime via import.meta.env).
// Set these in a local `.env` (see .env.example). All optional with safe dev defaults.
interface ImportMetaEnv {
  readonly WXT_ENGINE_URL?: string;
  readonly WXT_OAUTH_CLIENT_ID?: string;
  readonly WXT_MAGIC_ADDRESS?: string;
  /** Force verbose diagnostic logging in a production build ("1"/"true"). Off by
   *  default in prod; always on in dev. See lib/config.ts DEBUG. */
  readonly WXT_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
