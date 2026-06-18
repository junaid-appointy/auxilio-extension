import { useEffect, useRef, useState } from 'react';
import { LogOut, UserCircle2 } from 'lucide-react';
import { IconButton } from '@/design/components';
import { useAuthStatus, useSignOut } from './hooks';

/** Header account control: shows the signed-in host and a sign-out action. */
export function AccountMenu() {
  const auth = useAuthStatus();
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!auth.data?.signedIn) return null;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <IconButton label="Account" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <UserCircle2 size={20} strokeWidth={2} />
      </IconButton>
      {open && (
        <div
          role="menu"
          className="enter"
          style={{
            position: 'absolute',
            right: 0,
            top: '110%',
            minWidth: 200,
            background: 'var(--color-surface-lowest)',
            border: '1px solid var(--color-outline-variant)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--elev-2)',
            padding: 'var(--space-sm)',
            zIndex: 20,
          }}
        >
          <div className="type-label-sm text-muted" style={{ padding: '4px 8px 8px' }}>
            {auth.data.email ?? 'Signed in'}
          </div>
          <button
            role="menuitem"
            className="btn btn--text btn--block"
            style={{ justifyContent: 'flex-start' }}
            disabled={signOut.isPending}
            onClick={() => signOut.mutate(undefined, { onSuccess: () => setOpen(false) })}
          >
            <LogOut size={16} strokeWidth={2} />
            {signOut.isPending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
