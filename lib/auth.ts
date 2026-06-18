/**
 * Auth (background only). Mints a Google id_token (engine auth) + access_token
 * (Calendar read) via chrome.identity.launchWebAuthFlow against a Web OAuth
 * client, caches them in storage.session, and silently re-mints on expiry.
 *
 * The id_token's audience must be on the engine's AUXILIO_WORKSPACE_OAUTH_CLIENT_ID
 * allow-list. Calendar-only scopes (no Gmail/Drive — CASA line).
 */
import { OAUTH_CLIENT_ID } from './config';
import type { AuthStatus } from './types';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events.readonly',
].join(' ');

const KEY = 'auxilio.tokens';

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

async function mint(interactive: boolean): Promise<TokenBundle> {
  if (!OAUTH_CLIENT_ID) {
    throw new Error(
      'OAuth client id missing. Set WXT_OAUTH_CLIENT_ID in .env and rebuild.',
    );
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'token id_token');
  url.searchParams.set('redirect_uri', chrome.identity.getRedirectURL());
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('nonce', crypto.randomUUID());
  url.searchParams.set('prompt', interactive ? 'consent select_account' : 'none');

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive,
  });
  if (!redirect) throw new Error('Sign-in was cancelled');

  const { accessToken, idToken, expiresIn, error } = parseFragment(redirect);
  if (error) throw new Error(`Google sign-in error: ${error}`);
  if (!idToken || !accessToken) throw new Error('Sign-in did not return tokens');

  const bundle: TokenBundle = {
    idToken,
    accessToken,
    email: emailFromIdToken(idToken),
    expiresAt: Date.now() + (expiresIn - 60) * 1000, // refresh 60s early
  };
  await chrome.storage.session.set({ [KEY]: bundle });
  return bundle;
}

/** Valid tokens, silently re-minting if expired. Throws if interactive sign-in
 *  is required (caller surfaces a sign-in gate). */
export async function getValidTokens(): Promise<TokenBundle> {
  const cached = await readCache();
  if (cached && cached.expiresAt > Date.now()) return cached;
  return mint(false); // prompt=none silent renew
}

export async function signIn(): Promise<AuthStatus> {
  const bundle = await mint(true);
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
}

export async function authStatus(): Promise<AuthStatus> {
  const cached = await readCache();
  if (cached && cached.expiresAt > Date.now()) {
    return { signedIn: true, email: cached.email };
  }
  return { signedIn: false };
}
