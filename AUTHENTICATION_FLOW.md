# Authentication Flow

How the Auxilio Visitor Chrome extension authenticates the user and talks to
`office-ops-engine` — and an honest account of why it is secure where it counts,
plus the one known gap to close before public distribution.

> Scope: this covers the **extension** surface only. The `auxilio-workspace`
> Calendar add-on uses the same server-side verification (`addon-auth.ts`) with a
> different OAuth client id. See `../office-ops-engine/src/mastra/modules/visitor/addon-auth.ts`.

---

## TL;DR

- The extension is a **public client**: it holds **no client secret**, and there is
  no secret to expose.
- **Identity is not decided on the client.** Google signs an `id_token`; the engine
  verifies that signature **server-side** before trusting any email. The client is a
  conduit, not the authority. Identity therefore **cannot be forged from the client**.
- Runtime tokens live **only in the background service worker**, cached in
  `chrome.storage.session` (memory-only, never disk, never synced), and are
  unreadable by the content script.
- **Known gap:** token acquisition uses the **deprecated OAuth 2.0 implicit grant**
  (`response_type=token id_token`). It should move to **Authorization Code + PKCE**
  before public / Chrome Web Store distribution. PKCE needs no secret, so the
  "no secret" property is preserved. See [Known gap](#known-gap--before-public).

---

## Where credentials live

| Thing | Secret? | Where it lives |
| --- | --- | --- |
| OAuth **client id** (`WXT_OAUTH_CLIENT_ID`) | No — public by design | `.env` (gitignored); WXT inlines it into the built bundle at build time. Read in `lib/config.ts`. |
| OAuth **client secret** | — | **Does not exist.** Implicit flow / public client has no secret. |
| `id_token` (engine auth) + `access_token` (Calendar read) | Yes — runtime bearer | Background worker only, in `chrome.storage.session` under key `auxilio.tokens` (`lib/auth.ts`). |

`.env` is gitignored (`.gitignore`: `.env`, `.env.*`, except `.env.example`). Only
`.env.example` (blank value) is committed.

A **Web OAuth client id is not a secret** — it is visible in every OAuth request and
in the shipped bundle. That is expected and safe; security does not depend on hiding it.

---

## The flow, end to end

```
content script ──msg──> background ──HTTPS (Bearer id_token)──> engine /api/visitor/calendar/addon/*
side panel    ──msg──> background ──Calendar API (access_token)──> canonical iCalUID + attendees
```

Three surfaces, one custody boundary (background worker holds tokens + network):

1. **Content script** (`entrypoints/calendar.content.ts`) — dumb trigger on
   `calendar.google.com`. **No tokens, no network, no business logic.**
2. **Background service worker** (`entrypoints/background.ts`) — the **only** holder of
   tokens and the only thing that makes network calls.
3. **Side panel** (`entrypoints/sidepanel/`) — React UI. Presentation + server state
   only; it asks the background to act, it never sees a token.

### Acquiring tokens (`lib/auth.ts`)

1. Background calls `chrome.identity.launchWebAuthFlow` against Google's authorize
   endpoint, with the Web OAuth **client id** (no secret), the extension's
   `chrome.identity.getRedirectURL()` as `redirect_uri`, a random `nonce`, and the
   scopes below.
2. Scopes are **Calendar-only / identity**:
   `openid email profile https://www.googleapis.com/auth/calendar.events.readonly`.
   **Never widen to Gmail/Drive** — that crosses the CASA line (annual restricted-scope
   audit). Hard rule, same as the add-on.
3. Google returns `id_token` + `access_token` in the redirect URL **fragment**; the
   background parses them, derives `email` from the `id_token`, and caches the bundle
   in `chrome.storage.session` with an expiry set ~60s early.
4. **Silent renewal:** when the cache is expired, the background re-mints with
   `prompt=none` (no UI) — this works only while Google's session cookie is valid.
5. **Sign-out** revokes the `access_token` at Google's revoke endpoint and clears the
   cached bundle.

### Calling the engine (server-side trust)

Every request to `/api/visitor/calendar/addon/*` carries the `id_token` as a
`Bearer` header. The engine (`addon-auth.ts → verifyAddonIdToken`):

1. `OAuth2.verifyIdToken({ idToken, audience })` — verifies **Google's signature**,
   **issuer**, **expiry**, and that the token's `aud` is on the configured allow-list
   (`AUXILIO_EXTENSION_OAUTH_CLIENT_ID`, comma-separated).
2. Requires `email_verified === true`; rejects otherwise.
3. Trusts the resulting `email` as the host/organizer — **never** an organizer passed
   in the request body.
4. Applies an internal-domain gate (`isInternalHostEmail`) for internal-first.

This is the security anchor: **the engine, not the extension, decides who you are**,
and it does so by cryptographically verifying a Google-signed token.

> **Dev bypass:** `ADDON_DEV_TRUST_EMAIL` short-circuits verification and trusts a
> fixed email. It is gated to `NODE_ENV !== 'production'`, but **must never be set in
> production**.

---

## Why this is secure (where it counts)

- **No client secret to leak.** Public-client model; the only client-side credential is
  the (public) client id.
- **Identity is verified server-side.** A forged or tampered `id_token` fails
  signature/issuer/audience verification. The client cannot mint a trusted identity.
- **Audience pinning.** Only tokens whose `aud` is the extension's own client id are
  accepted, so a Google token minted for some other app is rejected.
- **Least privilege.** Calendar-read + identity only; no Gmail/Drive; stays below the
  CASA threshold.
- **Token custody is contained.** Tokens live only in the background worker's
  `chrome.storage.session` — memory-only, cleared when the browser closes, never
  written to disk, never synced. The content script (running in the page) cannot read
  them; the side panel cannot read them.
- **Transport.** All engine and Google calls are HTTPS; host permissions are pinned to
  specific origins in `wxt.config.ts`.

---

## Residual risks (true regardless of flow)

- **Bearer tokens = impersonation if exfiltrated.** Anyone who steals a live token can
  act as the user until it expires. Mitigations above (memory-only custody, short
  expiry, worker-only access) shrink the window and surface, but bearer is bearer.
- **Side-panel compromise.** An XSS in the React side panel cannot *read* the token,
  but it can *message the background to perform actions*. Treat side-panel input/render
  paths as a trust boundary; keep dependencies lean.
- **Silent renewal is fragile.** With no refresh token, `prompt=none` renewal depends on
  Google's session cookie; when that's gone the user must re-consent interactively.

---

## Known gap — before public

The token-acquisition flow uses the **OAuth 2.0 implicit grant**
(`response_type=token id_token`, `lib/auth.ts`). This is:

- **Removed in OAuth 2.1** and discouraged by the OAuth 2.0 Security BCP (RFC 9700).
- Weaker than the alternative: access token returned in the URL **fragment**
  (history/leak surface), **no refresh token**, no sender-constraining.
- A likely **finding in OAuth verification / Chrome Web Store review**, which the
  extension's own roadmap (internal-first → public) will hit (`CLAUDE.md`, hard rule 7).

**Recommended fix:** migrate to **Authorization Code + PKCE** via
`chrome.identity.launchWebAuthFlow`:

- Generate a `code_verifier` / `code_challenge` (PKCE), exchange the returned code for
  tokens. **PKCE replaces the need for a client secret**, so the public-client / "no
  secret" property is preserved.
- This also yields a proper **refresh token**, making renewal robust instead of
  cookie-dependent.

This is a self-contained change in `lib/auth.ts` (the engine contract is unchanged — it
still verifies an `id_token` audience). It is **not done yet** and is deferred to the
public-distribution phase.

---

## Hard rules (do not regress)

1. **Calendar-only scopes.** Never add Gmail/Drive (CASA line).
2. **Background is the only token + network holder.** Content script stays a dumb
   trigger; side panel stays presentation.
3. **No client secret in the extension.** Public client; keep it that way (PKCE, not a
   secret, when migrating off implicit).
4. **Engine owns identity.** Trust only the server-verified email, never a body field.
5. `ADDON_DEV_TRUST_EMAIL` is **dev-only** — never set in production.
