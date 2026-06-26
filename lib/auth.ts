/**
 * Auth (background only). Mints a Google id_token (engine auth) + access_token
 * (Calendar read) via chrome.identity.launchWebAuthFlow against a Web OAuth
 * client, caches them in storage.session, and silently re-mints on expiry.
 *
 * The id_token's audience must be on the engine's AUXILIO_WORKSPACE_OAUTH_CLIENT_ID
 * allow-list. Calendar-only scopes (no Gmail/Drive — CASA line).
 */
import { OAUTH_CLIENT_ID } from './config';
import { engine } from './engine';
import type { AuthStatus } from './types';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  // Resolve guest names + photos the Calendar event API omits for external guests
  // (People API, client-side — mirrors the add-on). Both are *sensitive* scopes,
  // NOT restricted → no CASA, and still no Gmail/Drive. Adding these requires each
  // user to re-consent once (a silent renew won't widen scope).
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
].join(' ');

const KEY = 'auxilio.tokens';

/** Durable (storage.local) marker that the user has connected and intends to stay
 *  connected. Token bundles live in storage.session and are WIPED on every browser
 *  restart, so an absent bundle can't tell "never signed in" from "session cleared,
 *  silent renew due." This flag survives restarts: while it's set, a failed silent
 *  renew means auth has lapsed (surface a reconnect), not that the user is signed
 *  out. Cleared only on explicit sign-out. */
const CONNECTED_KEY = 'auxilio.connected';
/** Durable copy of the connected account's email. storage.session (the token
 *  bundle) is wiped on browser restart, but a silent renew needs to know WHICH
 *  Google account to refresh — without a login_hint, prompt=none fails on a
 *  multi-account profile (Google can't pick one non-interactively), which surfaces
 *  as every write silently failing. Survives the restart so the hint is available. */
const EMAIL_KEY = 'auxilio.email';

interface TokenBundle {
  idToken: string;
  accessToken: string;
  email?: string;
  expiresAt: number;
}

function parseFragment(redirectUrl: string) {
  const params = new URLSearchParams(new URL(redirectUrl).hash.slice(1));
  return {
    accessToken: params.get('access_token') ?? '',
    idToken: params.get('id_token') ?? '',
    code: params.get('code') ?? '',
    expiresIn: Number(params.get('expires_in') ?? '3600'),
    error: params.get('error') ?? undefined,
  };
}

function emailFromIdToken(idToken: string): string | undefined {
  try {
    const part = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part)).email as string | undefined;
  } catch {
    return undefined;
  }
}

async function readCache(): Promise<TokenBundle | null> {
  const r = await chrome.storage.session.get(KEY);
  return (r[KEY] as TokenBundle) ?? null;
}

async function mint(
  interactive: boolean,
  loginHint?: string,
): Promise<{ bundle: TokenBundle; code?: string }> {
  if (!OAUTH_CLIENT_ID) {
    throw new Error(
      'OAuth client id missing. Set WXT_OAUTH_CLIENT_ID in .env and rebuild.',
    );
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  // Interactive: hybrid flow (+ offline) so we ALSO get a code to hand the engine
  // for a calendar refresh token. Silent renew stays implicit (client tokens only).
  url.searchParams.set('response_type', interactive ? 'code token id_token' : 'token id_token');
  url.searchParams.set('redirect_uri', chrome.identity.getRedirectURL());
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('nonce', crypto.randomUUID());
  url.searchParams.set('prompt', interactive ? 'consent select_account' : 'none');
  if (interactive) url.searchParams.set('access_type', 'offline');
  // Tell Google which account to (re)use. Essential for the silent prompt=none
  // renew on a multi-account profile — without it Google can't choose an account
  // non-interactively and the renew fails, dead-ending every authed request.
  if (loginHint) url.searchParams.set('login_hint', loginHint);

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive,
  });
  if (!redirect) throw new Error('Sign-in was cancelled');

  const { accessToken, idToken, code, expiresIn, error } = parseFragment(redirect);
  if (error) throw new Error(`Google sign-in error: ${error}`);
  if (!idToken || !accessToken) throw new Error('Sign-in did not return tokens');

  const email = emailFromIdToken(idToken);
  const bundle: TokenBundle = {
    idToken,
    accessToken,
    email,
    expiresAt: Date.now() + (expiresIn - 60) * 1000, // refresh 60s early
  };
  await chrome.storage.session.set({ [KEY]: bundle });
  // Persist the email durably so a later silent renew (after a restart wipes the
  // session bundle) still has a login_hint to pass.
  if (email) await chrome.storage.local.set({ [EMAIL_KEY]: email });
  return { bundle, code: code || undefined };
}

/** Durable email hint for silent renew (survives the restart that wipes the
 *  storage.session token bundle). */
async function readStoredEmail(): Promise<string | undefined> {
  const r = await chrome.storage.local.get(EMAIL_KEY);
  return (r[EMAIL_KEY] as string) ?? undefined;
}

/** Valid tokens, silently re-minting if expired. Throws if interactive sign-in
 *  is required (caller surfaces a sign-in gate). */
export async function getValidTokens(): Promise<TokenBundle> {
  const cached = await readCache();
  if (cached && cached.expiresAt > Date.now()) return cached;
  // prompt=none silent renew, passing the account hint so it works on a
  // multi-account profile. cached?.email covers the common case; the durable copy
  // covers a post-restart renew where the session bundle is gone.
  const hint = cached?.email ?? (await readStoredEmail());
  try {
    return (await mint(false, hint)).bundle;
  } catch (err) {
    console.warn('[auxilio] silent token renew failed', err);
    throw err;
  }
}

export async function signIn(): Promise<AuthStatus> {
  const { bundle, code } = await mint(true);
  // Mark "connected" durably so a later silent-renew failure reads as a lapse to
  // recover from, not a sign-out (see CONNECTED_KEY).
  await chrome.storage.local.set({ [CONNECTED_KEY]: true });
  // Best-effort: hand the auth code to the engine so it can mint a calendar
  // refresh token and keep passes in sync when the panel is closed. Never let a
  // failure here break sign-in — the engine's connectUrl CTA remains the fallback.
  if (code) {
    await engine
      .connectCalendar(bundle.idToken, code, chrome.identity.getRedirectURL())
      .catch((err) => console.warn('[auxilio] calendar connect failed', err));
  }
  return { signedIn: true, email: bundle.email };
}

export async function signOut(): Promise<void> {
  const cached = await readCache();
  if (cached?.accessToken) {
    await fetch(
      `https://oauth2.googleapis.com/revoke?token=${cached.accessToken}`,
      { method: 'POST' },
    ).catch(() => {});
  }
  await chrome.storage.session.remove(KEY);
  await chrome.storage.local.remove([CONNECTED_KEY, EMAIL_KEY]);
}

export async function authStatus(): Promise<AuthStatus> {
  const cached = await readCache();
  if (cached && cached.expiresAt > Date.now()) {
    return { signedIn: true, email: cached.email };
  }
  // Cached access token expired (it lives in storage.session, ~1h, and is wiped on
  // browser restart). Before reporting signed-out — which bounces the panel to the
  // sign-in gate roughly every hour — try the same silent (prompt=none) renew the
  // network path uses, but only if the user actually connected before. A successful
  // renew keeps them signed in transparently as long as the Google session lives;
  // only a genuine failure (revoked / really signed out) falls through to the gate.
  if (await wasConnected()) {
    try {
      const bundle = await getValidTokens();
      return { signedIn: true, email: bundle.email };
    } catch {
      return { signedIn: false };
    }
  }
  return { signedIn: false };
}

/** Did the user connect at least once and not explicitly sign out? Survives the
 *  restart that wipes the storage.session token cache — so the background can tell
 *  a recoverable auth lapse from a genuine signed-out state. */
export async function wasConnected(): Promise<boolean> {
  const r = await chrome.storage.local.get(CONNECTED_KEY);
  return !!r[CONNECTED_KEY];
}
