import { CheckCircle2, LogIn, LogOut } from 'lucide-react';
import { Button, Card, Logo } from '@/design/components';
import { ENGINE_BASE_URL, MAGIC_ADDRESS, OAUTH_CLIENT_ID } from '@/lib/config';
import { useAuthStatus, useSignIn, useSignOut } from '@/features/visit/hooks';

export default function Options() {
  const auth = useAuthStatus();
  const signIn = useSignIn();
  const signOut = useSignOut();
  const signedIn = auth.data?.signedIn;

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: 'var(--space-xl)', display: 'grid', gap: 'var(--space-lg)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
        <Logo size={32} />
        <span className="type-headline">Auxilio Visitor</span>
      </header>

      {/* Account */}
      <Card style={{ display: 'grid', gap: 'var(--space-md)' }}>
        <div className="type-title">Account</div>
        {signedIn ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <CheckCircle2 size={18} strokeWidth={2} style={{ color: 'var(--color-success)' }} />
            <span className="type-body row__grow">{auth.data?.email ?? 'Signed in'}</span>
            <Button
              variant="tonal"
              icon={<LogOut size={16} strokeWidth={2} />}
              loading={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              Sign out
            </Button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-sm)' }}>
            <span className="type-body text-muted">
              Connect your Google account to load guests and send visitor passes.
            </span>
            <Button
              icon={<LogIn size={18} strokeWidth={2} />}
              loading={signIn.isPending}
              onClick={() => signIn.mutate()}
              style={{ justifySelf: 'start' }}
            >
              Sign in with Google
            </Button>
            {!OAUTH_CLIENT_ID && (
              <span className="type-label-sm" style={{ color: 'var(--color-error)' }}>
                OAuth client id is not configured (set WXT_OAUTH_CLIENT_ID and rebuild).
              </span>
            )}
          </div>
        )}
      </Card>

      {/* Connection (read-only) */}
      <Card style={{ display: 'grid', gap: 'var(--space-md)' }}>
        <div className="type-title">Connection</div>
        <ConfigRow label="Engine" value={ENGINE_BASE_URL} />
        <ConfigRow label="Magic address" value={MAGIC_ADDRESS || 'not set'} />
        <span className="type-label-sm text-muted">
          These come from build-time env (.env). The magic address must match the
          engine's VISITOR_CALENDAR_INBOX_ADDRESS for the auto-nudge to fire.
        </span>
      </Card>

      {/* About */}
      <Card style={{ display: 'grid', gap: 'var(--space-xs)' }}>
        <div className="type-title">How it works</div>
        <span className="type-body text-muted">
          Open a Google Calendar event and use the side panel to register visitors.
          Events that include the magic address show an automatic banner; any other
          event shows a “Register a visitor” button. Visitor data, passes, and email
          all live in the engine. This extension is just the desktop surface.
        </span>
      </Card>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-md)' }}>
      <span className="type-label-sm text-muted" style={{ width: 110, flex: '0 0 auto' }}>
        {label}
      </span>
      <span
        className="type-body row__ellipsis"
        style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
      >
        {value}
      </span>
    </div>
  );
}
