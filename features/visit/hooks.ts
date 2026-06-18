import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ACTIVE_EID_KEY, rpc } from '@/lib/messaging';
import type {
  ActiveEvent,
  AuthStatus,
  DraftPatch,
  DraftResponse,
  VisitDraft,
} from '@/lib/types';

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

export function useResolveEvent(eid: string | null) {
  return useQuery({
    queryKey: ['resolve', eid],
    queryFn: () => rpc({ type: 'RESOLVE_EVENT', eid: eid! }),
    enabled: !!eid,
    staleTime: 60_000,
  });
}

export function useDraft(event: ActiveEvent | undefined) {
  return useQuery({
    queryKey: ['draft', event?.iCalUid],
    queryFn: () => rpc({ type: 'DRAFT_LOAD', event: event! }),
    enabled: !!event?.iCalUid,
  });
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
    onError: (_e, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (updated) => {
      qc.setQueryData<DraftResponse>(key, (prev) => mergeDraft(prev, updated));
    },
  });
}

/** Apply a DraftPatch to a cached DraftResponse for the optimistic view. */
function applyPatch(draft: DraftResponse, patch: DraftPatch): DraftResponse {
  const roster = draft.roster.map((g) => {
    const edit = patch.guests?.find(
      (e) => e.email.toLowerCase() === g.email.toLowerCase(),
    );
    return edit ? { ...g, ...stripEmail(edit) } : g;
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

export function usePreview(iCalUid: string | undefined) {
  return useMutation({
    mutationFn: (visitorEmail: string) =>
      rpc({ type: 'PREVIEW', iCalUid: iCalUid!, visitorEmail }),
  });
}
