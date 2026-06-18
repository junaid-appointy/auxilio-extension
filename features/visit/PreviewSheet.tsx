import { X } from 'lucide-react';
import { IconButton } from '@/design/components';
import type { PreviewResponse } from '@/lib/types';

/** Bottom sheet showing the exact branded email. The HTML is rendered in a
 *  sandboxed iframe (no scripts, no same-origin) so it can't touch the panel. */
export function PreviewSheet({
  preview,
  recipient,
  onClose,
}: {
  preview: PreviewResponse;
  recipient: string;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
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
          maxHeight: '88%',
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
            <div className="type-title">Email preview</div>
            <div className="type-label-sm text-muted row__ellipsis">
              To {recipient} · {preview.subject}
            </div>
          </div>
          <IconButton label="Close preview" onClick={onClose}>
            <X size={18} strokeWidth={2} />
          </IconButton>
        </header>
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={preview.html}
          style={{ border: 'none', width: '100%', flex: 1, background: '#fff' }}
        />
      </div>
    </div>
  );
}
