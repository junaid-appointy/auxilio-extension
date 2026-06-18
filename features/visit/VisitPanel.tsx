import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CalendarCheck,
  CheckCircle2,
  Clock,
  RefreshCw,
  Send,
  UserPlus,
} from 'lucide-react';
import { Button, Card, Skeleton, TextField } from '@/design/components';
import { EVENT_TOUCHED, RpcError } from '@/lib/messaging';
import type { PreviewResponse } from '@/lib/types';
import {
  useActiveEid,
  useDraft,
  usePatchDraft,
  usePreview,
  useResolveEvent,
  useSend,
} from './hooks';
import { RosterRow } from './RosterRow';
import { PreviewSheet } from './PreviewSheet';
import { SignInGate } from './SignInGate';

const isAuthError = (err: unknown) => err instanceof RpcError && !!err.needsAuth;

export function VisitPanel() {
  const eid = useActiveEid();
  const resolve = useResolveEvent(eid);
  const event = resolve.data;
  const draft = useDraft(event);

  const patch = usePatchDraft(event?.iCalUid);
  const send = useSend(event?.iCalUid, event?.start, event?.end);
  const preview = usePreview(event?.iCalUid);

  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{
    preview: PreviewResponse;
    recipient: string;
  } | null>(null);
  const [location, setLocation] = useState<string | null>(null);

  // Live refresh: when the content script reports the event's guests changed,
  // refetch so the roster stays current as the host edits in Calendar.
  const qc = useQueryClient();
  useEffect(() => {
    const listener = (msg: { type?: string }) => {
      if (msg?.type === EVENT_TOUCHED) {
        qc.invalidateQueries({ queryKey: ['resolve'] });
        qc.invalidateQueries({ queryKey: ['draft'] });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [qc]);

  // ---- gating states ----
  if (!eid) return <Shell><NoEvent /></Shell>;
  if (isAuthError(resolve.error) || isAuthError(draft.error)) {
    return <Shell><SignInGate /></Shell>;
  }
  if (resolve.isLoading) return <Shell><LoadingState label="Reading event…" /></Shell>;
  if (resolve.isError) {
    return (
      <Shell>
        <ErrorState message={(resolve.error as Error).message} onRetry={() => resolve.refetch()} />
      </Shell>
    );
  }
  if (draft.isLoading || !draft.data) {
    return <Shell><RosterSkeleton title={event?.title} /></Shell>;
  }
  if (draft.isError) {
    return (
      <Shell>
        <ErrorState message={(draft.error as Error).message} onRetry={() => draft.refetch()} />
      </Shell>
    );
  }

  const data = draft.data;
  const included = data.roster.filter((g) => g.include);
  const sentCount = data.roster.filter((g) => g.status === 'sent').length;
  const locValue = location ?? data.location ?? '';

  const patchGuest = (email: string, edit: Record<string, unknown>) =>
    patch.mutate({ guests: [{ email, ...edit }] });

  const doPreview = (email: string) => {
    setPreviewFor(email);
    preview.mutate(email, {
      onSuccess: (d) => {
        setPreviewData({ preview: d, recipient: email });
        setPreviewFor(null);
      },
      onError: () => setPreviewFor(null),
    });
  };

  const canSend = (included.length > 0 || data.materialized) && !send.isPending;
  const sendLabel = data.materialized ? 'Update passes' : 'Send passes';

  return (
    <Shell>
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
          <TextField
            label="Where visitors check in"
            value={locValue}
            placeholder="e.g. Front desk, 3rd floor"
            onChange={(e) => setLocation(e.target.value)}
            onBlur={() =>
              locValue !== (data.location ?? '') && patch.mutate({ location: locValue })
            }
          />
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
            <Card style={{ paddingTop: 0, paddingBottom: 0 }}>
              {data.roster.map((g) => (
                <RosterRow
                  key={g.email}
                  guest={g}
                  templates={data.emailTemplates}
                  onChange={(edit) => patchGuest(g.email, edit)}
                  onPreview={() => doPreview(g.email)}
                  previewing={previewFor === g.email}
                />
              ))}
            </Card>
          )}
        </section>

        {/* Send result */}
        {send.isSuccess && <SendSummary result={send.data} />}
        {send.isError && (
          <div className="banner banner--error">
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
          loading={send.isPending}
          disabled={!canSend}
          icon={<Send size={18} strokeWidth={2} />}
          onClick={() => send.mutate()}
        >
          {send.isPending
            ? 'Sending…'
            : `${sendLabel}${included.length ? ` (${included.length})` : ''}`}
        </Button>
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
          onClose={() => setPreviewData(null)}
        />
      )}
    </Shell>
  );
}

// ───────────────────────── sub-components ─────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
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
        <span
          style={{
            display: 'inline-flex',
            width: 28,
            height: 28,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-primary)',
            color: 'var(--color-on-primary)',
          }}
        >
          <CalendarCheck size={18} strokeWidth={2.2} />
        </span>
        <span className="type-title">Auxilio Visitor</span>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  );
}

function NoEvent() {
  return (
    <div style={{ padding: 'var(--space-lg)' }}>
      <Card
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 'var(--space-sm)',
          padding: 'var(--space-xl)',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            width: 48,
            height: 48,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--color-primary-container)',
            color: 'var(--color-on-primary-container)',
          }}
        >
          <UserPlus size={24} strokeWidth={2} />
        </span>
        <span className="type-title-lg">No event open</span>
        <span className="type-body text-muted">
          Open a Google Calendar event, then click{' '}
          <strong>Register a visitor</strong> to issue passes for your guests.
        </span>
      </Card>
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

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ padding: 'var(--space-lg)' }}>
      <div className="banner banner--error" style={{ marginBottom: 'var(--space-md)' }}>
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
