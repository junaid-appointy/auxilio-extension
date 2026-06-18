import { LogIn } from 'lucide-react';
import { Button, Card } from '@/design/components';
import { useSignIn } from './hooks';

/** Shown when the engine/Calendar call needs a signed-in host. */
export function SignInGate({ reason }: { reason?: string }) {
  const signIn = useSignIn();
  return (
    <div style={{ padding: 'var(--space-lg)' }}>
      <Card
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 'var(--space-md)',
          padding: 'var(--space-xl)',
        }}
      >
        <span className="type-title-lg">Sign in to continue</span>
        <span className="type-body text-muted">
          {reason ??
            'Connect your Google account to load guests and send visitor passes.'}
        </span>
        <Button
          icon={<LogIn size={18} strokeWidth={2} />}
          loading={signIn.isPending}
          onClick={() => signIn.mutate()}
        >
          Sign in with Google
        </Button>
        {signIn.isError && (
          <span className="type-label-sm" style={{ color: 'var(--color-error)' }}>
            {(signIn.error as Error).message}
          </span>
        )}
      </Card>
    </div>
  );
}
