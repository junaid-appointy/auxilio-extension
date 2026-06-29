import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  DoorOpen,
  ExternalLink,
  Eye,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import {
  Button,
  Card,
  IconButton,
  Logo,
  SelectField,
  Skeleton,
} from '@/design/components';
import {
  ACTIVE_EID_KEY,
  ACTIVE_SNAPSHOT_KEY,
  REFRESH_ACTIVE,
  RpcError,
  rpc,
} from '@/lib/messaging';
import { MAGIC_ADDRESS } from '@/lib/config';
import type { PreviewResponse } from '@/lib/types';
import {
  useActiveEid,
  useActiveSnapshot,
  useAuthStatus,
  useDraft,
  usePatchDraft,
  usePreview,
  useResolveEvent,
  useResolveGuestNames,
  useSend,
  useSignIn,
  useVisitorEvents,
} from './hooks';
import { AccountMenu } from './AccountMenu';
import { EmptyState } from './EmptyState';
import { RosterRow } from './RosterRow';
import { PreviewSheet } from './PreviewSheet';
import { SignInGate } from './SignInGate';

const isAuthError = (err: unknown) => err instanceof RpcError && !!err.needsAuth;

export function VisitPanel() {
  // `storedEid` is what the content script is pointing us at (auto-follow). We
  // freeze the *displayed* `eid` while busy so following never switches the view
  // mid-action (Guard 1); edits already persist on blur (Guard 2).
  const storedEid = useActiveEid();
  const snapshot = useActiveSnapshot();
  const [eid, setEid] = useState<string | null>(storedEid);
  const auth = useAuthStatus();
  // Picker fuels the "open from list" empty state (and graceful fallback).
  const visitorEvents = useVisitorEvents(!eid && !!auth.data?.signedIn);
  const resolve = useResolveEvent(eid);
  const event = resolve.data;
  // Host-only: only the event's ORGANIZER registers visitors. A guest who opens the
  // panel for an event they were merely invited to must not be able to edit/send —
  // their copy of the event carries the magic address too, but it isn't theirs to
  // manage. We compare the resolved organizer to the signed-in user; on any missing
  // signal we default to NOT a guest, so a legitimate host is never blocked.
  const myEmail = auth.data?.email?.toLowerCase();
  const organizerEmail = event?.organizerEmail?.toLowerCase();
  const isGuest = !!event && !!organizerEmail && !!myEmail && organizerEmail !== myEmail;
  const draft = useDraft(event, !isGuest);
  // Fill real names + photos for email-only guests in the background (People API).
  useResolveGuestNames(draft.data);

  const patch = usePatchDraft(event?.iCalUid);
  const send = useSend(event?.iCalUid, event?.start, event?.end);
  const preview = usePreview(event?.iCalUid);
  const signIn = useSignIn();

  // While a write is in flight, ignore the post-save REFRESH_ACTIVE refetch: a
  // DRAFT_LOAD that reads the engine before our PATCH commits would overwrite the
  // host's just-made edit (the "edit reverts" report). The mutation's own onSuccess
  // reconciles the draft when it settles. Ref so the listener reads the live value.
  const mutatingRef = useRef(false);
  mutatingRef.current = patch.isPending || send.isPending;

  const [previewData, setPreviewData] = useState<{
    preview: PreviewResponse;
    recipient: string;
  } | null>(null);
  // Non-structural host edits (name/phone change, template switch) leave no roster
  // delta, so we track them against a BASELINE captured lazily — the first time the
  // host touches a given guest (or the template), we snapshot its pre-edit value.
  // Deriving "edited" as a diff against that baseline means a revert back to the
  // original clears it (button deactivates), and a background name resolution that
  // fills an UNtouched guest is never mistaken for an edit (it's not in the baseline).
  // Refs (not state) so capturing doesn't itself trigger a render; the patch that
  // follows re-renders and recomputes the diff. Cleared when the event changes or a
  // send succeeds (the draft then reflects reality).
  const editBaseline = useRef<Record<string, { name: string; phone: string }>>({});
  const templateBaseline = useRef<string | undefined>(undefined);
  const resetEditBaseline = () => {
    editBaseline.current = {};
    templateBaseline.current = undefined;
  };
  useEffect(resetEditBaseline, [event?.iCalUid]);

  // Guard 1: hold the current event while sending / previewing; catch up once idle.
  const busy = send.isPending || preview.isPending || !!previewData;
  useEffect(() => {
    if (!busy) setEid(storedEid);
  }, [storedEid, busy]);

  // Post-save refresh: the background sync poll broadcasts when the active event
  // changed on the server (no DOM); refetch so the roster reflects saved state.
  const qc = useQueryClient();
  useEffect(() => {
    const listener = (msg: { type?: string }) => {
      if (msg?.type === REFRESH_ACTIVE) {
        // Don't clobber an in-flight edit (see mutatingRef).
        if (mutatingRef.current) return;
        qc.invalidateQueries({ queryKey: ['resolve'] });
        qc.invalidateQueries({ queryKey: ['draft'] });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [qc]);

  // Back → clear the active event/snapshot, returning to the home list.
  const clearActive = () =>
    chrome.storage.session.remove([ACTIVE_EID_KEY, ACTIVE_SNAPSHOT_KEY]);
  // Show Back in every screen except the pure home (no event, no snapshot).
  const back = eid || snapshot?.magicPresent ? clearActive : undefined;

  // ---- gating states ----
  if (!eid) {
    // New, not-yet-saved visitor event (no eid, but the DOM saw the magic
    // address) → preview the detected guests + prompt to save.
    if (snapshot?.magicPresent) {
      return (
        <Shell onBack={back}>
          <NoticeState
            title="Save the event to issue passes"
            body="This event isn’t saved yet, so passes can’t be issued. Add your guests and save it in Google Calendar, then reopen Manage Visitors."
            guests={snapshot.guestEmails}
          />
        </Shell>
      );
    }
    return (
      <Shell>
        <EmptyState
          auth={auth.data}
          events={visitorEvents.data}
          loading={visitorEvents.isLoading}
          onPick={(ev) => {
            // Just point the panel at the picked event — no tab navigation. Use
            // "Open in Calendar" in the summary to jump to it explicitly.
            chrome.storage.session.set({ [ACTIVE_EID_KEY]: ev.eid });
          }}
        />
      </Shell>
    );
  }
  if (isAuthError(resolve.error) || isAuthError(draft.error)) {
    return <Shell onBack={back}><SignInGate /></Shell>;
  }
  if (resolve.isLoading) return <Shell onBack={back}><LoadingState label="Reading event…" /></Shell>;
  if (resolve.isError) {
    const msg = (resolve.error as Error).message;
    if (msg === 'NOT_SAVED') {
      return (
        <Shell onBack={back}>
          <NoticeState
            title="Save the event to issue passes"
            body="This event isn’t saved yet, so passes can’t be issued. Save it in Google Calendar, then reopen Manage Visitors."
            onRetry={() => resolve.refetch()}
            guests={snapshot?.guestEmails}
          />
        </Shell>
      );
    }
    return (
      <Shell onBack={back}>
        <ErrorState message={msg} onRetry={() => resolve.refetch()} />
      </Shell>
    );
  }
  // Guest of someone else's event → nothing to manage here (see isGuest above).
  if (isGuest) {
    return (
      <Shell onBack={back}>
        <NoticeState
          title="You are a guest of this event"
          body={`${hostNameFromEmail(event?.organizerEmail)} manages visitor passes for this event. There is nothing for you to do here.`}
        />
      </Shell>
    );
  }
  // Event resolved but no iCalUID → the draft query can't run (would sit on a
  // skeleton forever). Surface it instead of hanging.
  if (event && !event.iCalUid) {
    return (
      <Shell onBack={back}>
        <NoticeState
          title="Can’t register from this event"
          body="This event has no calendar UID yet. This usually means it is not fully saved. Save it in Google Calendar and try again."
          onRetry={() => resolve.refetch()}
        />
      </Shell>
    );
  }
  if (draft.isError) {
    return (
      <Shell onBack={back}>
        <ErrorState message={(draft.error as Error).message} onRetry={() => draft.refetch()} />
      </Shell>
    );
  }
  if (!draft.data) {
    return <Shell onBack={back}><RosterSkeleton title={event?.title} /></Shell>;
  }

  // Defense in depth: the marker (magic) address must NEVER render as a guest. We
  // strip it on the way OUT to the engine (lib/calendar.ts) and the engine strips it
  // too, but a draft the engine persisted earlier — or one its conservative reconcile
  // preserves when the event has no other guests left (the "toggle the only internal
  // member off → magic reappears" report) — can still come back carrying it. Filter the
  // engine-returned roster here so it can't reach the panel regardless of that path.
  const data = {
    ...draft.data,
    roster: draft.data.roster.filter((g) => g.email.toLowerCase() !== MAGIC_ADDRESS),
  };
  const included = data.roster.filter((g) => g.include);
  const sentCount = data.roster.filter((g) => g.status === 'sent').length;

  const templates = data.emailTemplates;
  // One template for the whole event (engine stores per-guest; we set all guests
  // to the chosen key).
  const currentTemplate =
    data.roster.find((g) => g.emailTemplateKey)?.emailTemplateKey ??
    templates.find((t) => t.isDefault)?.key ??
    templates[0]?.key;

  // What's actually pending. A new/uninvited guest still to get a pass, or a sent
  // guest toggled off (a pending revoke), is a STRUCTURAL change visible in the
  // roster (and reverts cleanly because it's recomputed here every render).
  const pendingNew = data.roster.filter(
    (g) => g.include && g.status !== 'sent' && g.status !== 'cancelled',
  );
  const pendingCancel = data.roster.filter((g) => g.status === 'sent' && !g.include);

  // Non-structural edits: guests whose name/phone now differs from their captured
  // baseline, or a template switched away from its baseline. Reverting to the
  // baseline value drops the guest back out, so the button deactivates.
  const editedGuests = data.roster.filter((g) => {
    const b = editBaseline.current[g.email];
    return !!b && ((g.name ?? '') !== b.name || (g.phone ?? '') !== b.phone);
  });
  const templateChanged =
    templateBaseline.current !== undefined && currentTemplate !== templateBaseline.current;
  const edited = editedGuests.length > 0 || templateChanged;

  const hasChanges = pendingNew.length > 0 || pendingCancel.length > 0 || edited;

  // How many passes this send will actually change. A FIRST send issues a pass to
  // every included guest, so the count is the whole included list. An UPDATE to an
  // already-issued event only touches what the host changed — newly added guests,
  // pending cancels, and the specific guests whose name/phone was edited — so editing
  // one guest among five reports one, not five. (A template switch re-renders every
  // included guest's email, so it counts as all of them.)
  const changeCount = !data.materialized
    ? included.length
    : templateChanged
      ? included.length
      : pendingNew.length + pendingCancel.length + editedGuests.length;
  // Already-issued event with literally nothing to do → no point re-sending.
  const nothingToDo = data.materialized && !hasChanges;

  const patchGuest = (email: string, edit: Record<string, unknown>) => {
    // An include toggle is STRUCTURAL (pendingNew/pendingCancel) — no baseline needed.
    // For a name/phone edit, snapshot this guest's PRE-edit values the first time it's
    // touched, so a later revert (or a background name fill on an untouched guest)
    // diffs correctly.
    if ('name' in edit || 'phone' in edit) {
      if (!(email in editBaseline.current)) {
        const g = data.roster.find((x) => x.email === email);
        if (g) editBaseline.current[email] = { name: g.name ?? '', phone: g.phone ?? '' };
      }
    }
    patch.mutate({ guests: [{ email, ...edit }] });
  };

  const setEventTemplate = (key: string) => {
    // Snapshot the effective template before the first switch, so picking the
    // original template back clears the diff.
    if (templateBaseline.current === undefined) templateBaseline.current = currentTemplate;
    patch.mutate({ guests: data.roster.map((g) => ({ email: g.email, emailTemplateKey: key })) });
  };

  // Review & send: render the real email for a representative included guest,
  // then Send/Cancel from the preview.
  const reviewEmail = included[0]?.email;
  const openReview = () => {
    if (!reviewEmail) return;
    preview.mutate(reviewEmail, {
      onSuccess: (d) => setPreviewData({ preview: d, recipient: reviewEmail }),
    });
  };

  // First send needs at least one included guest; an already-issued event needs a
  // real pending change — otherwise the button is irrelevant and stays disabled.
  const canSend =
    !send.isPending && (data.materialized ? hasChanges : included.length > 0);
  const reviewLabel = data.materialized ? 'Review & update passes' : 'Review & send passes';
  // A write (edit or send) failed because the session lapsed. Surface it instead of
  // letting the change silently revert — the host signs in again and re-sends.
  const writeAuthError = isAuthError(patch.error) || isAuthError(send.error);

  return (
    <Shell onBack={back}>
      <div className="enter" style={{ padding: 'var(--space-lg)', display: 'grid', gap: 'var(--space-lg)' }}>
        {/* Event summary */}
        <Card style={{ display: 'grid', gap: 'var(--space-sm)' }}>
          <div className="type-title-lg">{event?.title || 'Untitled event'}</div>
          {event?.start && (
            <div className="type-body text-muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Clock size={15} strokeWidth={2} />
              {formatWhen(event.start, event.end)}
            </div>
          )}
          {event?.rooms && event.rooms.length > 0 && (
            <div className="type-body text-muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <DoorOpen size={15} strokeWidth={2} />
              <span className="row__ellipsis">{event.rooms.join(', ')}</span>
            </div>
          )}
          {event?.description && (
            <div
              className="type-label-sm text-muted"
              style={{
                whiteSpace: 'pre-wrap',
                maxHeight: 72,
                overflow: 'hidden',
                borderTop: '1px solid var(--color-outline-variant)',
                paddingTop: 'var(--space-sm)',
              }}
            >
              {event.description}
            </div>
          )}
          {eid && (
            <Button
              variant="text"
              icon={<ExternalLink size={16} strokeWidth={2} />}
              onClick={() => void rpc({ type: 'NAVIGATE_TO_EVENT', eid })}
              // Negative left margin = the text button's own horizontal padding,
              // so the label optically aligns to the card edge while the hit area
              // and hover state layer stay intact (MD3 text-button placement).
              style={{ justifySelf: 'start', marginLeft: 'calc(-1 * var(--space-md))' }}
            >
              Open in Calendar
            </Button>
          )}
          {templates.length >= 2 && (
            <SelectField
              label="Email template (all guests)"
              value={currentTemplate}
              onChange={(e) => setEventTemplate(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                  {t.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </SelectField>
          )}
        </Card>

        {/* Roster */}
        <section>
          <div
            className="type-label-sm text-muted"
            style={{ textTransform: 'uppercase', marginBottom: 4 }}
          >
            Guests · {included.length} getting a pass
          </div>
          {data.roster.length === 0 ? (
            <Card className="type-body text-muted">
              No guests on this event yet. Add attendees in Calendar, then reopen.
            </Card>
          ) : (
            <div className="roster">
              {data.roster.map((g) => (
                <RosterRow
                  key={g.email}
                  guest={g}
                  onChange={(edit) => patchGuest(g.email, edit)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Send result */}
        {send.isSuccess && <SendSummary result={send.data} />}
        {send.isError && !isAuthError(send.error) && (
          <div className="banner banner--error" role="alert">
            <AlertCircle size={18} strokeWidth={2} style={{ flex: '0 0 auto' }} />
            <span className="type-body">{(send.error as Error).message}</span>
          </div>
        )}
      </div>

      {/* Sticky action bar */}
      <footer
        style={{
          padding: 'var(--space-md) var(--space-lg)',
          borderTop: '1px solid var(--color-outline-variant)',
          background: 'var(--color-surface-lowest)',
        }}
      >
        <AutoHideBanner show={nothingToDo}>
          <div
            className="banner banner--info"
            role="status"
            style={{ marginBottom: 'var(--space-sm)' }}
          >
            <CheckCircle2 size={18} strokeWidth={2} style={{ flex: '0 0 auto' }} />
            <span className="type-body">Up to date. No changes to send.</span>
          </div>
        </AutoHideBanner>
        {writeAuthError && (
          <div
            className="banner banner--error"
            role="alert"
            style={{ marginBottom: 'var(--space-sm)', flexWrap: 'wrap' }}
          >
            <AlertCircle size={18} strokeWidth={2} style={{ flex: '0 0 auto' }} />
            <span className="type-body" style={{ flex: 1, minWidth: 180 }}>
              Your session expired. Sign in again to save your changes.
            </span>
            <Button
              variant="tonal"
              loading={signIn.isPending}
              icon={<LogIn size={16} strokeWidth={2} />}
              onClick={() => signIn.mutate()}
            >
              Sign in
            </Button>
          </div>
        )}
        <Button
          block
          loading={preview.isPending}
          disabled={!canSend}
          icon={<Eye size={18} strokeWidth={2} />}
          onClick={openReview}
        >
          {preview.isPending
            ? 'Loading preview…'
            : `${reviewLabel}${changeCount ? ` (${changeCount})` : ''}`}
        </Button>
        {preview.isError && (
          <div className="type-label-sm" style={{ color: 'var(--color-error)', textAlign: 'center', marginTop: 6 }}>
            {(preview.error as Error).message}
          </div>
        )}
        {sentCount > 0 && !send.isPending && !nothingToDo && (
          <div className="type-label-sm text-muted" style={{ textAlign: 'center', marginTop: 6 }}>
            {sentCount} pass{sentCount > 1 ? 'es' : ''} already issued
          </div>
        )}
      </footer>

      {previewData && (
        <PreviewSheet
          preview={previewData.preview}
          recipient={previewData.recipient}
          totalCount={changeCount}
          update={data.materialized}
          sending={send.isPending}
          onSend={() =>
            send.mutate(undefined, {
              onSuccess: () => {
                setPreviewData(null);
                resetEditBaseline();
              },
            })
          }
          onClose={() => setPreviewData(null)}
        />
      )}
    </Shell>
  );
}

// ───────────────────────── sub-components ─────────────────────────

/** Shows its children for ~5s each time `show` flips true, then auto-hides — an
 *  ephemeral notice rather than a banner that lingers. Re-shows if `show` cycles. */
function AutoHideBanner({ show, children }: { show: boolean; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!show) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(t);
  }, [show]);
  return visible ? <>{children}</> : null;
}

function Shell({ children, onBack }: { children: React.ReactNode; onBack?: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 320 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          padding: 'var(--space-md) var(--space-lg)',
          borderBottom: '1px solid var(--color-outline-variant)',
          flex: '0 0 auto',
        }}
      >
        {onBack ? (
          <IconButton label="Back to events" onClick={onBack}>
            <ArrowLeft size={20} strokeWidth={2} />
          </IconButton>
        ) : (
          <Logo size={26} />
        )}
        <span className="type-title">Auxilio Visitor</span>
        <span style={{ flex: 1 }} />
        <AccountMenu />
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-md)',
        color: 'var(--color-on-surface-variant)',
      }}
    >
      <span className="spinner" style={{ width: 22, height: 22 }} />
      <span className="type-body">{label}</span>
    </div>
  );
}

function RosterSkeleton({ title }: { title?: string }) {
  return (
    <div style={{ padding: 'var(--space-lg)', display: 'grid', gap: 'var(--space-lg)' }}>
      <Card style={{ display: 'grid', gap: 8 }}>
        <span className="type-title-lg">{title || 'Loading event…'}</span>
        <Skeleton width="60%" />
      </Card>
      <Card style={{ display: 'grid', gap: 'var(--space-lg)' }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'center' }}>
            <Skeleton width={44} height={24} radius={999} />
            <div style={{ flex: 1, display: 'grid', gap: 6 }}>
              <Skeleton width="50%" />
              <Skeleton width="70%" height={12} />
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function NoticeState({
  title,
  body,
  onRetry,
  guests,
}: {
  title: string;
  body: string;
  onRetry?: () => void;
  guests?: string[];
}) {
  return (
    <div style={{ padding: 'var(--space-lg)', display: 'grid', gap: 'var(--space-md)' }}>
      <Card style={{ display: 'grid', gap: 'var(--space-sm)', padding: 'var(--space-xl)' }}>
        <span className="type-title-lg">{title}</span>
        <span className="type-body text-muted">{body}</span>
        {onRetry && (
          <Button
            variant="tonal"
            icon={<RefreshCw size={16} strokeWidth={2} />}
            onClick={onRetry}
            style={{ justifySelf: 'start', marginTop: 'var(--space-xs)' }}
          >
            Check again
          </Button>
        )}
      </Card>
      {guests && guests.length > 0 && (
        <Card style={{ display: 'grid', gap: 'var(--space-xs)' }}>
          <span className="type-label-sm text-muted" style={{ textTransform: 'uppercase' }}>
            Guests detected on this event
          </span>
          {guests.map((g) => (
            <span key={g} className="type-body row__ellipsis">{g}</span>
          ))}
        </Card>
      )}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ padding: 'var(--space-lg)' }}>
      <div className="banner banner--error" role="alert" style={{ marginBottom: 'var(--space-md)' }}>
        <AlertCircle size={18} strokeWidth={2} style={{ flex: '0 0 auto' }} />
        <span className="type-body">{message}</span>
      </div>
      <Button variant="tonal" icon={<RefreshCw size={16} strokeWidth={2} />} onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function SendSummary({
  result,
}: {
  result: import('@/lib/types').SendResponse;
}) {
  return (
    <div
      className="banner"
      role="status"
      aria-live="polite"
      style={{ background: 'var(--color-success-container)', color: 'var(--color-on-success-container)' }}
    >
      <CheckCircle2 size={18} strokeWidth={2} style={{ flex: '0 0 auto' }} />
      <div>
        <div className="type-label">
          {(() => {
            const updatedCount = result.updated?.length ?? 0;
            if (result.created.length > 0)
              return `${result.created.length} pass${result.created.length > 1 ? 'es' : ''} sent`;
            if (updatedCount > 0)
              return `${updatedCount} pass${updatedCount > 1 ? 'es' : ''} updated`;
            if (result.cancelled.length > 0) return 'Passes updated';
            return 'No changes';
          })()}
          {result.cancelled.length > 0 && ` · ${result.cancelled.length} cancelled`}
        </div>
        {result.failed.length > 0 && (
          <ul className="type-label-sm" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {result.failed.map((f) => (
              <li key={f.visitorEmail}>
                {f.visitorEmail}: {f.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Friendly host name from the organizer email (local part, title-cased), for the
 *  guest notice. Falls back to "The host" when there's no usable email. */
function hostNameFromEmail(email?: string): string {
  const local = (email ?? '').split('@')[0] ?? '';
  const name = local
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  return name || 'The host';
}

function formatWhen(start: string, end?: string): string {
  const allDay = !start.includes('T');
  const s = new Date(start);
  const date = s.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (allDay) return `${date} · All day`;
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return end ? `${date} · ${t(s)} to ${t(new Date(end))}` : `${date} · ${t(s)}`;
}
