import { Send, X } from 'lucide-react';
import { Button, IconButton } from '@/design/components';
import type { PreviewResponse } from '@/lib/types';

/**
 * Bottom sheet showing the exact branded email (the real engine template,
 * rendered server-side), with Cancel / Send beneath it. The HTML is rendered in
 * a sandboxed iframe (no scripts, no same-origin) so it can't touch the panel.
 */
export function PreviewSheet({
  preview,
  recipient,
  totalCount,
  sending,
  onSend,
  onClose,
}: {
  preview: PreviewResponse;
  recipient: string;
  totalCount: number;
  sending: boolean;
  onSend: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={sending ? undefined : onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-scrim)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        zIndex: 10,
      }}
    >
      <div
        className="enter"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface-lowest)',
          borderTopLeftRadius: 'var(--radius-xl)',
          borderTopRightRadius: 'var(--radius-xl)',
          maxHeight: '90%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-sm)',
            padding: 'var(--space-md) var(--space-lg)',
            borderBottom: '1px solid var(--color-outline-variant)',
          }}
        >
          <div className="row__grow">
            <div className="type-title">Review email</div>
            <div className="type-label-sm text-muted row__ellipsis">
              {preview.subject}
            </div>
          </div>
          <IconButton label="Close preview" onClick={onClose} disabled={sending}>
            <X size={18} strokeWidth={2} />
          </IconButton>
        </header>

        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={preview.html}
          style={{ border: 'none', width: '100%', flex: 1, minHeight: 280, background: '#fff' }}
        />

        <footer
          style={{
            display: 'grid',
            gap: 'var(--space-sm)',
            padding: 'var(--space-md) var(--space-lg)',
            borderTop: '1px solid var(--color-outline-variant)',
          }}
        >
          <div className="type-label-sm text-muted" style={{ textAlign: 'center' }}>
            Preview for {recipient} · {totalCount} pass{totalCount > 1 ? 'es' : ''} will be
            sent
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
            <Button variant="text" onClick={onClose} disabled={sending} style={{ flex: 1 }}>
              Cancel
            </Button>
            <Button
              block
              loading={sending}
              icon={<Send size={18} strokeWidth={2} />}
              onClick={onSend}
              style={{ flex: 2 }}
            >
              {sending ? 'Sending…' : `Send ${totalCount} pass${totalCount > 1 ? 'es' : ''}`}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
