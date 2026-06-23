# Authentication Flow

How the Auxilio Visitor Chrome extension authenticates the user and talks to
`office-ops-engine` — including the **hybrid single-consent flow** that connects the
engine's calendar in the same sign-in — and an honest account of why it is secure where it
counts, plus the known gaps to close before public distribution.

> Scope: this covers the **extension** surface only. The `auxilio-workspace`
> Calendar add-on uses the same server-side verification (`addon-auth.ts`) with a
> different OAuth client id. See `../office-ops-engine/src/mastra/modules/visitor/addon-auth.ts`.

---

## TL;DR

- **One Google consent does two jobs.** Interactive sign-in uses a **hybrid OAuth flow**
  (`response_type=code token id_token` + `access_type=offline`): the *extension* gets
  short-lived client tokens, and the *engine* gets a durable **refresh token** — from a
  single consent screen, with no second "Connect calendar" prompt. See
  [The hybrid single-consent flow](#the-hybrid-single-consent-flow-end-to-end).
- **The extension bundle holds no secret.** The OAuth client is a *Web* client and it
  *does* have a secret, but that secret lives **only on the engine** and is used **only**
  for the server-side code→refresh-token exchange. Nothing secret ships in the extension.
- **Identity is not decided on the client.** Google signs an `id_token`; the engine
  verifies that signature **server-side** before trusting any email. The client is a
  conduit, not the authority. Identity therefore **cannot be forged from the client**.
- Runtime tokens (access + id) live **only in the background service worker**, cached in
  `chrome.storage.session` (memory-only, never disk, never synced), and are unreadable by
  the content script. The **refresh token never touches the browser** — it is minted and
  stored server-side.
- **Known gap:** the durable refresh token is stored **plaintext at rest** in the engine
  DB, and silent renewal still uses the implicit grant. See
  [Known gaps](#known-gaps--before-public).

---

## Where credentials live

| Thing | Secret? | Where it lives |
| --- | --- | --- |
| OAuth **client id** (`WXT_OAUTH_CLIENT_ID`) | No — public by design | `.env` (gitignored); WXT inlines it into the built bundle at build time. Read in `lib/config.ts`. |
| OAuth **client secret** (`AUXILIO_EXTENSION_OAUTH_CLIENT_SECRET`) | Yes | **Engine only** — never in the extension bundle. Used solely to exchange the hybrid-flow `code` for a refresh token (`exchangeExtensionCalendarCode`, `office-ops-engine/.../calendar-oauth.ts`). |
| `id_token` (engine auth) + `access_token` (Calendar read) | Yes — runtime bearer | Background worker only, in `chrome.storage.session` under key `auxilio.tokens` (`lib/auth.ts`). |
| **refresh token** (closed-panel calendar read) | Yes — durable | **Engine DB only** (`calendar_connections.refresh_token`, tagged `scope_version = 'v-ext-events-ro'`). Never reaches the browser. Currently **plaintext at rest** — see [Known gaps](#known-gaps--before-public). |

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
   endpoint, with the Web OAuth **client id** (no secret in the bundle), the extension's
   `chrome.identity.getRedirectURL()` as `redirect_uri`, a random `nonce`, and the
   scopes below.
2. Scopes are **Calendar-only / identity**:
   `openid email profile https://www.googleapis.com/auth/calendar.events.readonly`.
   **Never widen to Gmail/Drive** — that crosses the CASA line (annual restricted-scope
   audit). Hard rule, same as the add-on.
3. **Interactive sign-in is a hybrid request:** `response_type=code token id_token`,
   `access_type=offline`, `prompt=consent select_account`. Google returns three things in
   the redirect URL **fragment** at once: `access_token` + `id_token` (the client tokens)
   **and** a one-time `code` (for the engine). The background caches the client bundle in
   `chrome.storage.session` (expiry set ~60s early) and hands the `code` to the engine
   (next section).
4. **Silent renewal** stays implicit: when the cache is expired, the background re-mints
   with `response_type=token id_token` + `prompt=none` (no UI, no new code). This works
   only while Google's session cookie is valid; on failure the user re-consents.
5. **Sign-out** revokes the `access_token` at Google's revoke endpoint and clears the
   cached bundle. (It does not revoke the engine-side refresh token.)

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

## The hybrid single-consent flow (end to end)

The goal: **one** Google consent should leave us with both (a) live tokens in the
extension for the open-panel UI, and (b) a durable refresh token on the engine so visitor
passes stay in sync **when the side panel is closed**. We get both from a single screen by
asking Google for a *hybrid* response. No second "Connect calendar" prompt.

### Three tokens, three owners

One sign-in yields three credentials. The whole design is about who gets which:

| Token | Lives where | Lifespan | Job |
| --- | --- | --- | --- |
| **access_token** (`calendar.events.readonly`) | extension — `chrome.storage.session` | ~1 h | extension reads the open event's live calendar data (canonical iCalUID + attendees) while the panel is open |
| **id_token** (identity) | extension — `chrome.storage.session` | ~1 h | proves "this is `<host>`" to the engine on every `/addon/*` call (Bearer) |
| **refresh_token** (durable) | **engine DB only** (`calendar_connections`) | until revoked | lets the engine's 5-min poll read the calendar **when the panel/browser is closed** |

### Step by step, from the click

1. **You click "Sign in."** The button (`features/visit/SignInGate.tsx`, or the options
   page) calls `useSignIn()`, which sends a typed `{ type: 'AUTH_SIGN_IN' }` RPC to the
   background worker (`lib/messaging.ts`). The panel holds no token and just waits.
2. **The background worker handles it** (`entrypoints/background.ts`, `case 'AUTH_SIGN_IN'`)
   and calls `signIn()` in `lib/auth.ts`. Everything past here happens in the only room
   allowed to hold tokens.
3. **The worker opens the one Google consent screen** (`mint(true)`), requesting
   `response_type=code token id_token` + `access_type=offline` + `prompt=consent
   select_account`, scoped to identity + `calendar.events.readonly`.
4. **You approve.** Google routes its reply only to the extension (to
   `https://<extension-id>.chromiumapp.org/`, locked to this extension). In the URL
   **fragment** are all three at once: `access_token`, `id_token`, and a one-time `code`.
5. **The worker splits the bundle** (`parseFragment` + `signIn`): it **keeps** the
   access_token + id_token in `chrome.storage.session` (these power the live UI) and marks
   the user durably "connected" (so a later silent-renew failure reads as a recoverable
   lapse, not a sign-out). It **does not keep** the `code`.
6. **The worker hands the `code` to the engine** — `engine.connectCalendar(idToken, code,
   redirectUri)` → `POST /api/visitor/calendar/addon/connect-calendar`, authenticated with
   the id_token as Bearer. This is **best-effort**: if it fails, sign-in still succeeds and
   the dashboard "Connect calendar" CTA remains the fallback (the failure is logged, not
   surfaced).
7. **The engine cashes in the one-time `code`** (`routes.ts` → `exchangeExtensionCalendarCode`):
   it trades the code with Google for the **refresh_token**. This trade requires the
   **client secret**, which only the engine holds. It stores the token in
   `calendar_connections`, tagged `scope_version = 'v-ext-events-ro'`. If the host is
   already connected (e.g. via Slack/OAuth), it leaves the existing token untouched (D7 —
   never downgrade a write-capable connection).
8. **Done.** Two independent capabilities now exist from that single consent:
   - **Panel open:** the extension uses its access_token to read events live.
   - **Panel closed:** the engine's 5-min poll (`calendar-sync.ts`) uses the stored
     refresh token to detect moves/cancels and keep passes in sync — no browser needed.

### The critical detail: a refresh token belongs to the client that minted it

The refresh token was minted with the **extension's** Web client, so it can **only** be
refreshed with that client (id + secret). The engine therefore selects the client per
connection: `clientForConnection(conn)` (`calendar-oauth.ts`) uses the **extension** client
when `scope_version === 'v-ext-events-ro'`, and the engine's own admin-SSO client
otherwise. The poll **and** the watch path both go through it. **If this ever regresses to
always using the engine client, the first poll throws `invalid_grant` and revokes the
connection.** This is the single most important invariant on the engine side.

### Why "hybrid"?

Normally you pick one flow:

- **Implicit** (`token id_token`) — tokens land straight in the browser. Good for a client,
  but **no refresh token**, so access dies when the browser closes.
- **Authorization code** (`code`) — a one-time code a *server* exchanges (with a secret) for
  tokens **including a refresh token**. Good for a server, but the browser gets no usable
  tokens directly.

We need **both outcomes from one consent**, so we ask for both response types together —
`code token id_token`. One screen, two recipients:

```
                You click Sign in
                       │
              Background worker  ── opens ONE Google consent ──┐
                       │                                        │
        ┌───────── Google returns (one fragment) ──────────────┘
        │   access_token + id_token            code            │
        └──────────────┬──────────────────────────┬────────────┘
                       │                           │
            kept in the extension          sent to the engine
            (storage.session)              (Bearer: id_token)
                       │                           │
                       ▼                           ▼
            reads the open event          engine exchanges code (+secret)
            via Calendar API              → refresh_token → calendar_connections
                                                  │
                                                  ▼
                                      5-min poll reads the calendar
                                      even when the panel is closed
```

---

## Why this is secure (where it counts)

- **No secret in the extension.** The only client-side credential is the (public) client
  id. The client secret exists but lives **only on the engine**, used solely for the
  server-side code→refresh-token exchange — so it cannot be extracted from the bundle.
- **The durable credential never reaches the browser.** The refresh token is minted and
  stored server-side; the browser only ever holds short-lived tokens that self-expire and
  are wiped on restart. The one-time `code` that carries the grant is useless to a thief —
  it is single-use, short-lived, and redeemable only with the engine-held secret.
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
- **Silent renewal is fragile.** The extension keeps no refresh token of its own, so
  `prompt=none` renewal of the *client* tokens depends on Google's session cookie; when
  that's gone the user must re-consent interactively.
- **The engine becomes a credential store.** The durable refresh token sits in
  `calendar_connections.refresh_token` as **plaintext** (see below). Scope caps the blast
  radius at calendar **read-only**, but a DB/backup/query-log leak yields working,
  no-interaction calendar-read access for every connected user. Encrypt it at rest, lock
  DB access, and keep the token value out of logs.

---

## Known gaps — before public

### 1. Refresh token is plaintext at rest (engine)

The durable refresh token is stored as a plain `TEXT` column in
`calendar_connections.refresh_token` — **no encryption at rest**. This is now the highest-
value secret in the system (persistent, directly usable, one per connected user). Fix:
envelope-encrypt on write in `upsertCalendarConnection` and decrypt in
`clientForConnection` / `getCalendarConnection`, with the key from env (KMS-backed
ideally); at minimum ensure DB-at-rest encryption, tight access, and no token in logs.

### 2. Client tokens still ride the implicit grant

Interactive sign-in is now **hybrid** (`code token id_token`) — the durable grant comes via
the **authorization code** (exchanged server-side with the secret), which is the strong
path. But the *client* tokens (`access_token`, `id_token`) still arrive via the implicit
`token` portion in the URL **fragment**, and **silent renewal** still uses
`response_type=token id_token` + `prompt=none` (`lib/auth.ts`). The implicit grant is:

- **Removed in OAuth 2.1** and discouraged by the OAuth 2.0 Security BCP (RFC 9700).
- Fragment-delivered (history/leak surface), no sender-constraining.
- A likely **finding in OAuth verification / Chrome Web Store review**, which the
  extension's roadmap (internal-first → public) will hit (`CLAUDE.md`, hard rule 7).

**Recommended fix:** drop the implicit `token` portion and obtain the client tokens via
**Authorization Code + PKCE** too (the engine already does a confidential-client code
exchange for the refresh token, so the moving parts exist). The engine contract is
unchanged — it still verifies an `id_token` audience. Deferred to the public-distribution
phase.

---

## Hard rules (do not regress)

1. **Calendar-only scopes.** Never add Gmail/Drive (CASA line).
2. **Background is the only token + network holder.** Content script stays a dumb
   trigger; side panel stays presentation.
3. **No client secret in the extension bundle.** The OAuth client's secret lives only on
   the engine (for the code exchange); the bundle ships only the public client id. Keep it
   that way (use PKCE, not a bundled secret, for any client-side token work).
4. **Engine owns identity.** Trust only the server-verified email, never a body field.
5. `ADDON_DEV_TRUST_EMAIL` is **dev-only** — never set in production.
