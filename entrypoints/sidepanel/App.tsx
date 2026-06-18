import { CalendarCheck, UserPlus } from 'lucide-react';
import { Card } from '@/design/components';

/**
 * Phase 0 shell: branded header + empty state. Phase 1 replaces the body with
 * the live registration flow (roster, toggles, preview, send) driven by the
 * active Calendar event context from the background worker.
 */
export default function App() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minWidth: 320,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          padding: 'var(--space-lg)',
          borderBottom: '1px solid var(--color-outline-variant)',
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

      <main style={{ flex: 1, padding: 'var(--space-lg)' }}>
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
      </main>
    </div>
  );
}
