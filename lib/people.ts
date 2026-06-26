/**
 * People API name + photo resolution (background only).
 *
 * Why: Google omits `attendee.displayName` for external non-contact guests — the
 * name Calendar's web UI shows is resolved client-side from the host's Google
 * Contacts and never reaches the event API. We replicate that with the host's own
 * `access_token` (the same client-side pattern the Calendar add-on uses), so the
 * side panel can upgrade a guest's email-derived fallback name (and show a profile
 * photo) with no backend round-trip.
 *
 * Needs contacts.readonly + contacts.other.readonly on the OAuth consent (see
 * lib/auth SCOPES). Resolves only emails the host has saved or interacted with —
 * fails gracefully (returns nothing) for everyone else. Never throws.
 */
import type { ResolvedPerson } from './types';

const PEOPLE_BASE = 'https://people.googleapis.com/v1';
const CACHE_KEY = 'auxilio.peopleCache';
const CACHE_VERSION_KEY = 'auxilio.peopleCacheV';
/** Bump to drop the persisted cache on next load. v2 = discard caches written by the
 *  pre-fix code that stored lookup ERRORS as a 7-day "not found" (poisoning
 *  resolution for a week after a transient 403 / warmup race). */
const CACHE_VERSION = 2;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a found name/photo changes rarely
/** A genuine "not found" is cached only briefly so a guest the host saves to
 *  Contacts later resolves the same day instead of staying blank for a week. */
const NEG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 1000;

type CacheEntry = { person: ResolvedPerson | null; at: number };

// In-memory cache for this service-worker's life (null = looked up, not found).
// MV3 workers are short-lived, so we also persist to storage.local below.
const mem = new Map<string, ResolvedPerson | null>();
let warmed = false;

interface PeoplePerson {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  photos?: { url?: string; default?: boolean }[];
}

async function search(
  path: string,
  query: string,
  readMask: string,
  accessToken: string,
): Promise<{ results?: { person?: PeoplePerson }[] }> {
  const url = new URL(`${PEOPLE_BASE}/${path}`);
  url.searchParams.set('query', query);
  url.searchParams.set('readMask', readMask);
  url.searchParams.set('pageSize', '5');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`People ${path} ${res.status}`);
  return res.json();
}

/** Google primes the search index only after a prior request, so an empty-query
 *  call must precede the first real one. Once per worker life. */
async function warmup(accessToken: string): Promise<void> {
  if (warmed) return;
  warmed = true;
  await Promise.all([
    search('people:searchContacts', '', 'names,emailAddresses', accessToken).catch(() => undefined),
    search('otherContacts:search', '', 'names,emailAddresses', accessToken).catch(() => undefined),
  ]);
}

/** A result only counts if it actually carries the email we searched (the search is
 *  fuzzy). Skip Google's generic silhouette photo (`default: true`). */
function pick(person: PeoplePerson | undefined, email: string): ResolvedPerson | undefined {
  if (!person) return undefined;
  const emails = person.emailAddresses ?? [];
  if (!emails.some((e) => e.value?.toLowerCase() === email.toLowerCase())) return undefined;
  const name = person.names?.[0]?.displayName?.trim();
  const photo = (person.photos ?? []).find((p) => p.url && !p.default);
  const out: ResolvedPerson = {};
  if (name) out.name = name;
  if (photo?.url) out.photoUrl = photo.url;
  return out.name || out.photoUrl ? out : undefined;
}

/** Resolve one email. Returns a person, or null for a GENUINE "not found" (every
 *  lookup succeeded with no match). THROWS when a lookup errored and produced no
 *  hit — the result is indeterminate, so the caller must NOT cache it as not-found
 *  (a transient 403 / network blip / un-warmed index would otherwise poison the
 *  cache). This is the fix for "contacts resolution silently stops working." */
async function resolveOne(email: string, accessToken: string): Promise<ResolvedPerson | null> {
  let errored = false;
  try {
    const own = await search('people:searchContacts', email, 'names,emailAddresses,photos', accessToken);
    for (const r of own.results ?? []) {
      const hit = pick(r.person, email);
      if (hit) return hit;
    }
  } catch (err) {
    errored = true;
    console.warn('[auxilio] searchContacts failed', email, err);
  }
  try {
    // otherContacts readMask does not reliably support photos → names only.
    const other = await search('otherContacts:search', email, 'names,emailAddresses', accessToken);
    for (const r of other.results ?? []) {
      const hit = pick(r.person, email);
      if (hit) return hit;
    }
  } catch (err) {
    errored = true;
    console.warn('[auxilio] otherContacts.search failed', email, err);
  }
  if (errored) throw new Error(`people lookup indeterminate for ${email}`);
  return null; // every lookup succeeded, no match → genuine not-found (cacheable)
}

/**
 * Resolve real name + photo for the given guest emails. Returns only the ones we
 * found something for. Cached (memory + storage.local with a TTL), looked up in
 * parallel, and best-effort — a failure for one email never rejects the whole call.
 */
export async function resolveGuests(
  accessToken: string,
  emails: string[],
): Promise<Record<string, ResolvedPerson>> {
  const want = [...new Set(emails.map((e) => e.toLowerCase()).filter(Boolean))];
  if (want.length === 0) return {};

  const persisted = await loadCache();
  const out: Record<string, ResolvedPerson> = {};
  const todo: string[] = [];

  for (const email of want) {
    const m = mem.get(email);
    if (m !== undefined) {
      if (m) out[email] = m;
      continue;
    }
    const p = persisted[email];
    // A found result lives long; a "not found" expires quickly so a later-saved
    // contact resolves the same day rather than staying blank for a week.
    const ttl = p?.person ? CACHE_TTL_MS : NEG_CACHE_TTL_MS;
    if (p && Date.now() - p.at < ttl) {
      mem.set(email, p.person);
      if (p.person) out[email] = p.person;
      continue;
    }
    todo.push(email);
  }

  if (todo.length > 0) {
    await warmup(accessToken);
    const results = await Promise.allSettled(todo.map((e) => resolveOne(e, accessToken)));
    let dirty = false;
    todo.forEach((email, i) => {
      const r = results[i];
      // Transient failure (rejected) → do NOT cache; leave it to retry next open.
      // Only persist a definitive answer (a person, or a real not-found null).
      if (r.status !== 'fulfilled') return;
      const person = r.value;
      mem.set(email, person);
      persisted[email] = { person, at: Date.now() };
      if (person) out[email] = person;
      dirty = true;
    });
    if (dirty) await saveCache(persisted);
  }
  return out;
}

async function loadCache(): Promise<Record<string, CacheEntry>> {
  try {
    const r = await chrome.storage.local.get([CACHE_KEY, CACHE_VERSION_KEY]);
    // Drop a cache written by an older (buggy) version — e.g. the one that cached
    // lookup errors as a 7-day "not found". One-time, on the first load after a bump.
    if (r[CACHE_VERSION_KEY] !== CACHE_VERSION) {
      await chrome.storage.local.set({ [CACHE_VERSION_KEY]: CACHE_VERSION, [CACHE_KEY]: {} });
      return {};
    }
    return (r[CACHE_KEY] as Record<string, CacheEntry>) ?? {};
  } catch {
    return {};
  }
}

async function saveCache(cache: Record<string, CacheEntry>): Promise<void> {
  try {
    // Drop expired entries, then cap to the most recent CACHE_MAX so the store
    // can't grow without bound.
    const now = Date.now();
    let entries = Object.entries(cache).filter(([, v]) => now - v.at < CACHE_TTL_MS);
    if (entries.length > CACHE_MAX) {
      entries = entries.sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_MAX);
    }
    await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries) });
  } catch {
    /* best-effort cache */
  }
}
