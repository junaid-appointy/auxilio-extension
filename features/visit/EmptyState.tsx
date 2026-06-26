import { CalendarClock, CheckCircle2, ChevronRight, UserPlus } from 'lucide-react';
import { Card, Spinner } from '@/design/components';
import type { AuthStatus, PanelVisitorEvent } from '@/lib/types';
import { SignInGate } from './SignInGate';

/**
 * Shown when no event is active — the homescreen. A MANAGEMENT surface: it lists
 * both visitor events still needing passes and ones whose passes are already sent
 * (so finished work is confirmed, not silently hidden, and a sent event can be
 * reopened to update or cancel). Doubles as the "open from list" fallback if
 * click-detection ever breaks. Signed-out users get the sign-in here too.
 */
export function EmptyState({
  auth,
  events,
  loading,
  onPick,
}: {
  auth: AuthStatus | undefined;
  events: PanelVisitorEvent[] | undefined;
  loading: boolean;
  onPick: (ev: PanelVisitorEvent) => void;
}) {
  if (!auth) {
    return (
      <Centered>
        <Spinner size={22} />
      </Centered>
    );
  }
  if (!auth.signedIn) {
    return <SignInGate reason="Sign in to see your visitor events and register passes." />;
  }

  const pending = (events ?? []).filter((e) => e.status === 'pending');
  const sent = (events ?? []).filter((e) => e.status === 'sent');
  const firstLoad = loading && !events;

  return (
    <div style={{ padding: 'var(--space-lg)', display: 'grid', gap: 'var(--space-lg)' }}>
      <Card
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-md)',
          padding: 'var(--space-lg)',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            width: 40,
            height: 40,
            flex: '0 0 auto',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--color-primary-container)',
            color: 'var(--color-on-primary-container)',
          }}
        >
          <UserPlus size={20} strokeWidth={2} />
        </span>
        <span className="type-body text-muted">
          Open a Calendar event and click <strong>Register a visitor</strong>, or pick
          a visitor event below.
        </span>
      </Card>

      <Section title="Visitor events needing passes">
        {firstLoad ? (
          <Centered>
            <Spinner size={20} />
          </Centered>
        ) : pending.length > 0 ? (
          <EventList events={pending} onPick={onPick} />
        ) : (
          <Card className="type-body text-muted">
            No events need passes right now. Open a Calendar event and click
            Register a visitor to send passes.
          </Card>
        )}
      </Section>

      {sent.length > 0 && (
        <Section title="Passes sent">
          <EventList events={sent} onPick={onPick} sent />
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div
        className="type-label-sm text-muted"
        style={{ textTransform: 'uppercase', marginBottom: 4 }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

function EventList({
  events,
  onPick,
  sent,
}: {
  events: PanelVisitorEvent[];
  onPick: (ev: PanelVisitorEvent) => void;
  sent?: boolean;
}) {
  return (
    <Card style={{ paddingTop: 0, paddingBottom: 0 }}>
      {events.map((ev) => (
        <button
          key={ev.eid}
          className="row"
          onClick={() => onPick(ev)}
          style={{
            width: '100%',
            background: 'transparent',
            border: 'none',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <CalendarClock
            size={18}
            strokeWidth={2}
            style={{ flex: '0 0 auto', color: 'var(--color-on-surface-variant)' }}
          />
          <div className="row__grow">
            <div className="type-label row__ellipsis">{ev.title}</div>
            {ev.start && (
              <div className="type-label-sm text-muted">{formatWhen(ev.start)}</div>
            )}
          </div>
          {sent ? (
            <span
              className="type-label-sm"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                flex: '0 0 auto',
                color: 'var(--color-success)',
              }}
            >
              <CheckCircle2 size={15} strokeWidth={2} />
              Sent
            </span>
          ) : (
            <ChevronRight
              size={18}
              strokeWidth={2}
              style={{ flex: '0 0 auto', color: 'var(--color-outline)' }}
            />
          )}
        </button>
      ))}
    </Card>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-xxl)',
        color: 'var(--color-on-surface-variant)',
      }}
    >
      {children}
    </div>
  );
}

function formatWhen(start: string): string {
  const allDay = !start.includes('T');
  const d = new Date(start);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (allDay) return `${date} · All day`;
  return `${date} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
