import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  DoorOpen,
  ExternalLink,
  Eye,
  RefreshCw,
} from 'lucide-react';
import {
  Button,
  Card,
  IconButton,
  Logo,
  SelectField,
  Skeleton,
  TextField,
} from '@/design/components';
import {
  ACTIVE_EID_KEY,
  ACTIVE_SNAPSHOT_KEY,
  REFRESH_ACTIVE,
  RpcError,
  rpc,
} from '@/lib/messaging';
import type { PreviewResponse } from '@/lib/types';
import {
  useActiveEid,
  useActiveSnapshot,
  useAuthStatus,
  useDraft,
  usePatchDraft,
  usePreview,
  useResolveEvent,
  useSend,
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
  const draft = useDraft(event);

  const patch = usePatchDraft(event?.iCalUid);
  const send = useSend(event?.iCalUid, event?.start, event?.end);
  const preview = usePreview(event?.iCalUid);

  const [previewData, setPreviewData] = useState<{
    preview: PreviewResponse;
    recipient: string;
  } | null>(null);
  const [location, setLocation] = useState<string | null>(null);

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
  // Event resolved but no iCalUID → the draft query can't run (would sit on a
  // skeleton forever). Surface it instead of hanging.
  if (event && !event.iCalUid) {
    return (
      <Shell onBack={back}>
        <NoticeState
          title="Can’t register from this event"
          body="This event has no calendar UID yet — usually because it isn’t fully saved. Save it in Google Calendar and try again."
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

  const data = draft.data;
  const included = data.roster.filter((g) => g.include);
  const sentCount = data.roster.filter((g) => g.status === 'sent').length;
  const locValue = location ?? data.location ?? '';

  const templates = data.emailTemplates;
  // One template for the whole event (engine stores per-guest; we set all guests
  // to the chosen key).
  const currentTemplate =
    data.roster.find((g) => g.emailTemplateKey)?.emailTemplateKey ??
    templates.find((t) => t.isDefault)?.key ??
    templates[0]?.key;

  const patchGuest = (email: string, edit: Record<string, unknown>) =>
    patch.mutate({ guests: [{ email, ...edit }] });

  const setEventTemplate = (key: string) =>
    patch.mutate({ guests: data.roster.map((g) => ({ email: g.email, emailTemplateKey: key })) });

  // Review & send: render the real email for a representative included guest,
  // then Send/Cancel from the preview.
  const reviewEmail = included[0]?.email;
  const openReview = () => {
    if (!reviewEmail) return;
    preview.mutate(reviewEmail, {
      onSuccess: (d) => setPreviewData({ preview: d, recipient: reviewEmail }),
    });
  };

  const canSend = (included.length > 0 || data.materialized) && !send.isPending;
  const reviewLabel = data.materialized ? 'Review & update passes' : 'Review & send passes';

  return (
    <Shell onBack={back}>
      <div className="enter" style={{ padding: 'var(--space-lg)', display: 'grid', gap: 'var(--space-lg)' }}>
        <div
          className="type-label-sm text-muted"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <Eye size={13} strokeWidth={2} />
          Following the event open in Calendar
        </div>
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
          <TextField
            label="Where visitors check in"
            value={locValue}
            placeholder="e.g. Front desk, 3rd floor"
            onChange={(e) => setLocation(e.target.value)}
            onBlur={() =>
              locValue !== (data.location ?? '') && patch.mutate({ location: locValue })
            }
          />
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
            <Card style={{ paddingTop: 0, paddingBottom: 0, overflow: 'hidden' }}>
              {data.roster.map((g) => (
                <RosterRow
                  key={g.email}
                  guest={g}
                  onChange={(edit) => patchGuest(g.email, edit)}
                />
              ))}
            </Card>
          )}
        </section>

        {/* Send result */}
        {send.isSuccess && <SendSummary result={send.data} />}
        {send.isError && (
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
        <Button
          block
          loading={preview.isPending}
          disabled={!canSend}
          icon={<Eye size={18} strokeWidth={2} />}
          onClick={openReview}
        >
          {preview.isPending
            ? 'Loading preview…'
            : `${reviewLabel}${included.length ? ` (${included.length})` : ''}`}
        </Button>
        {preview.isError && (
          <div className="type-label-sm" style={{ color: 'var(--color-error)', textAlign: 'center', marginTop: 6 }}>
            {(preview.error as Error).message}
          </div>
        )}
        {sentCount > 0 && !send.isPending && (
          <div className="type-label-sm text-muted" style={{ textAlign: 'center', marginTop: 6 }}>
            {sentCount} pass{sentCount > 1 ? 'es' : ''} already issued
          </div>
        )}
      </footer>

      {previewData && (
        <PreviewSheet
          preview={previewData.preview}
          recipient={previewData.recipient}
          totalCount={included.length}
          sending={send.isPending}
          onSend={() =>
            send.mutate(undefined, { onSuccess: () => setPreviewData(null) })
          }
          onClose={() => setPreviewData(null)}
        />
      )}
    </Shell>
  );
}

// ───────────────────────── sub-components ─────────────────────────

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
          {result.created.length > 0
            ? `${result.created.length} pass${result.created.length > 1 ? 'es' : ''} sent`
            : 'Passes updated'}
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

function formatWhen(start: string, end?: string): string {
  const allDay = !start.includes('T');
  const s = new Date(start);
  const date = s.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (allDay) return `${date} · All day`;
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return end ? `${date} · ${t(s)}–${t(new Date(end))}` : `${date} · ${t(s)}`;
}
