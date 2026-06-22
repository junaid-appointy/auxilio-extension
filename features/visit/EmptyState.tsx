import { CalendarClock, ChevronRight, UserPlus } from 'lucide-react';
import { Card, Spinner } from '@/design/components';
import type { AuthStatus, VisitorEventSummary } from '@/lib/types';
import { SignInGate } from './SignInGate';

/**
 * Shown when no event is active. Doubles as the "open from list" fallback if
 * click-detection ever breaks: pick an upcoming visitor event to register.
 * Signed-out users get the sign-in here too (no need to open an event first).
 */
export function EmptyState({
  auth,
  events,
  loading,
  onPick,
}: {
  auth: AuthStatus | undefined;
  events: VisitorEventSummary[] | undefined;
  loading: boolean;
  onPick: (ev: VisitorEventSummary) => void;
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

      <section>
        <div
          className="type-label-sm text-muted"
          style={{ textTransform: 'uppercase', marginBottom: 4 }}
        >
          Visitor events needing passes
        </div>

        {loading && !events ? (
          <Centered>
            <Spinner size={20} />
          </Centered>
        ) : events && events.length > 0 ? (
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
                <ChevronRight
                  size={18}
                  strokeWidth={2}
                  style={{ flex: '0 0 auto', color: 'var(--color-outline)' }}
                />
              </button>
            ))}
          </Card>
        ) : (
          <Card className="type-body text-muted">
            No upcoming visitor events found. They appear here once an event includes
            the visitor address.
          </Card>
        )}
      </section>
    </div>
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
