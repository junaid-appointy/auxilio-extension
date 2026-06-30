import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ACTIVE_EID_KEY, ACTIVE_SNAPSHOT_KEY, RpcError, rpc } from '@/lib/messaging';
import type {
  ActiveEvent,
  AuthStatus,
  DomEventSnapshot,
  DraftPatch,
  DraftResponse,
  VisitDraft,
} from '@/lib/types';

const isAuthError = (e: unknown) => e instanceof RpcError && !!e.needsAuth;

/** The pending event id, read reactively from storage.session. */
export function useActiveEid(): string | null {
  const [eid, setEid] = useState<string | null>(null);
  useEffect(() => {
    chrome.storage.session
      .get(ACTIVE_EID_KEY)
      .then((r) => setEid((r[ACTIVE_EID_KEY] as string) ?? null));
    const listener = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === 'session' && changes[ACTIVE_EID_KEY]) {
        setEid((changes[ACTIVE_EID_KEY].newValue as string) ?? null);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return eid;
}

/** The DOM snapshot for the active event (instant + unsaved fallback). */
export function useActiveSnapshot(): DomEventSnapshot | null {
  const [snap, setSnap] = useState<DomEventSnapshot | null>(null);
  useEffect(() => {
    chrome.storage.session
      .get(ACTIVE_SNAPSHOT_KEY)
      .then((r) => setSnap((r[ACTIVE_SNAPSHOT_KEY] as DomEventSnapshot) ?? null));
    const listener = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === 'session' && changes[ACTIVE_SNAPSHOT_KEY]) {
        setSnap((changes[ACTIVE_SNAPSHOT_KEY].newValue as DomEventSnapshot) ?? null);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return snap;
}

export function useAuthStatus() {
  return useQuery({
    queryKey: ['auth'],
    queryFn: () => rpc({ type: 'AUTH_STATUS' }),
  });
}

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => rpc({ type: 'AUTH_SIGN_IN' }),
    onSuccess: (status: AuthStatus) => {
      qc.setQueryData(['auth'], status);
      // re-run any failed queries now that we're signed in
      qc.invalidateQueries();
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => rpc({ type: 'AUTH_SIGN_OUT' }),
    onSuccess: () => {
      qc.setQueryData(['auth'], { signedIn: false });
      // Drop draft/resolve caches so the panel re-gates to sign-in.
      qc.removeQueries({ queryKey: ['draft'] });
      qc.removeQueries({ queryKey: ['resolve'] });
    },
  });
}

export function useResolveEvent(eid: string | null) {
  return useQuery({
    queryKey: ['resolve', eid],
    queryFn: () => rpc({ type: 'RESOLVE_EVENT', eid: eid! }),
    enabled: !!eid,
    staleTime: 60_000,
  });
}

export function useDraft(event: ActiveEvent | undefined, enabled = true) {
  return useQuery({
    queryKey: ['draft', event?.iCalUid],
    queryFn: () => rpc({ type: 'DRAFT_LOAD', event: event! }),
    // `enabled` lets the caller suppress the engine draft call entirely for an event
    // the user only attends (a guest) — they never register visitors, so we don't
    // load/create a draft for them.
    enabled: enabled && !!event?.iCalUid,
  });
}

/**
 * Background-enrich the draft: for guests we only have an email-derived fallback
 * name for (`nameIsFallback`), resolve the real name + photo from the host's Google
 * contacts and merge them into the cached draft. Non-destructive — it only rewrites
 * cache fields; RosterRow adopts an updated name/photo solely when the host hasn't
 * edited that field, so a late resolve never clobbers a live correction. One-shot
 * per distinct set of pending guests (cached in the background after the first run).
 */
export function useResolveGuestNames(draft: DraftResponse | undefined) {
  const qc = useQueryClient();
  const iCalUid = draft?.iCalUid;
  const pending = (draft?.roster ?? [])
    .filter((g) => g.nameIsFallback)
    .map((g) => g.email.toLowerCase())
    .sort();
  // Stable key so the effect fires only when the pending set actually changes.
  const key = pending.join('|');

  useEffect(() => {
    if (!iCalUid || pending.length === 0) return;
    let cancelled = false;
    rpc({ type: 'RESOLVE_GUESTS', emails: pending })
      .then((resolved) => {
        if (cancelled || !resolved || Object.keys(resolved).length === 0) return;
        // Names we upgraded from a fallback → persist them to the engine so the
        // materialized PASS + EMAIL use the real name, not the email-derived
        // fallback. Resolution is client-side only, so without this the engine's
        // stored draft (and thus the sent invite) keeps the trimmed name.
        const current = qc.getQueryData<DraftResponse>(['draft', iCalUid]);
        const namePatch = (current?.roster ?? [])
          .map((g) => {
            const name = resolved[g.email.toLowerCase()]?.name;
            return g.nameIsFallback && name ? { email: g.email, name } : null;
          })
          .filter((x): x is { email: string; name: string } => x !== null);

        qc.setQueryData<DraftResponse>(['draft', iCalUid], (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            roster: prev.roster.map((g) => {
              const hit = resolved[g.email.toLowerCase()];
              if (!hit) return g;
              // Only FILL a still-fallback name — never overwrite a real or
              // host-edited name with a contacts lookup (that late write was the
              // "edit reverts" bug). The photo can still upgrade either way.
              const fill = g.nameIsFallback;
              return {
                ...g,
                name: fill ? (hit.name ?? g.name) : g.name,
                photoUrl: hit.photoUrl ?? g.photoUrl,
                nameIsFallback: fill && hit.name ? false : g.nameIsFallback,
              };
            }),
          };
        });

        if (namePatch.length > 0 && !cancelled) {
          rpc({ type: 'DRAFT_PATCH', iCalUid, patch: { guests: namePatch } }).catch(
            () => {
              /* best-effort: the name is still shown; only persistence failed */
            },
          );
        }
      })
      .catch(() => {
        /* name resolution is best-effort — failures keep the fallback name */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iCalUid, key]);
}

/** Merge a returned VisitDraft into the cached DraftResponse (keep extras). */
function mergeDraft(
  prev: DraftResponse | undefined,
  next: VisitDraft,
): DraftResponse | undefined {
  if (!prev) return prev;
  return { ...prev, ...next };
}

/** Optimistic patch (toggle / name / phone / template / location). */
export function usePatchDraft(iCalUid: string | undefined) {
  const qc = useQueryClient();
  const key = ['draft', iCalUid];
  return useMutation({
    mutationFn: (patch: DraftPatch) =>
      rpc({ type: 'DRAFT_PATCH', iCalUid: iCalUid!, patch }),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<DraftResponse>(key);
      if (prev) qc.setQueryData<DraftResponse>(key, applyPatch(prev, patch));
      return { prev };
    },
    onError: (err, _patch, ctx) => {
      // On an auth lapse, KEEP the optimistic edit — don't silently discard what the
      // host typed. The panel surfaces a reconnect prompt; after re-auth the value is
      // still on screen to re-commit/send. Roll back only for genuine (non-auth)
      // failures, where the change really didn't take.
      if (isAuthError(err)) return;
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (updated, patch) => {
      qc.setQueryData<DraftResponse>(key, (prev) => {
        const merged = mergeDraft(prev, updated);
        if (!merged) return merged;
        // The engine echoes the guest's OLD nameIsFallback (patchDraft doesn't clear
        // it when a name is set), which would re-arm the contacts resolver to clobber
        // the host's name. Keep it cleared client-side for any guest we just named.
        const named = new Set(
          (patch.guests ?? [])
            .filter((g) => typeof g.name === 'string' && g.name.trim())
            .map((g) => g.email.toLowerCase()),
        );
        if (named.size === 0) return merged;
        return {
          ...merged,
          roster: merged.roster.map((g) =>
            named.has(g.email.toLowerCase()) ? { ...g, nameIsFallback: false } : g,
          ),
        };
      });
    },
  });
}

/** Apply a DraftPatch to a cached DraftResponse for the optimistic view. */
function applyPatch(draft: DraftResponse, patch: DraftPatch): DraftResponse {
  const roster = draft.roster.map((g) => {
    const edit = patch.guests?.find(
      (e) => e.email.toLowerCase() === g.email.toLowerCase(),
    );
    if (!edit) return g;
    const next = { ...g, ...stripEmail(edit) };
    // A host-typed name is authoritative: stop marking it a fallback so the
    // contacts resolver no longer targets it — and changing the fallback set
    // cancels any in-flight resolve for this guest (the effect key changes).
    if (typeof edit.name === 'string' && edit.name.trim()) next.nameIsFallback = false;
    return next;
  });
  return {
    ...draft,
    roster,
    location: patch.location ?? draft.location,
  };
}

function stripEmail<T extends { email: string }>(e: T): Omit<T, 'email'> {
  const { email: _email, ...rest } = e;
  return rest;
}

export function useSend(iCalUid: string | undefined, start?: string, end?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => rpc({ type: 'SEND', iCalUid: iCalUid!, start, end }),
    onSuccess: (res) => {
      qc.setQueryData<DraftResponse>(['draft', iCalUid], (prev) =>
        mergeDraft(prev, res.draft),
      );
    },
  });
}

/** Cancel ALL passes for the event in one call (the host's "Cancel all passes").
 *  On success the engine has revoked + emailed each guest; we mark the cached draft's
 *  sent guests cancelled so the panel reflects it immediately, then refetch. */
export function useCancelEvent(iCalUid: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => rpc({ type: 'CANCEL_EVENT', iCalUid: iCalUid! }),
    onSuccess: () => {
      qc.setQueryData<DraftResponse>(['draft', iCalUid], (prev) =>
        prev
          ? {
              ...prev,
              roster: prev.roster.map((g) =>
                g.status === 'sent' ? { ...g, status: 'cancelled', include: false } : g,
              ),
            }
          : prev,
      );
      qc.invalidateQueries({ queryKey: ['draft', iCalUid] });
    },
  });
}

export function usePreview(iCalUid: string | undefined) {
  return useMutation({
    mutationFn: (visitorEmail: string) =>
      rpc({ type: 'PREVIEW', iCalUid: iCalUid!, visitorEmail }),
  });
}

/** Upcoming visitor events (the synced magic-address set) for the picker. */
export function useVisitorEvents(enabled: boolean) {
  return useQuery({
    queryKey: ['visitorEvents'],
    queryFn: () => rpc({ type: 'LIST_VISITOR_EVENTS' }),
    enabled,
    staleTime: 30_000,
  });
}
