import { Send, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton } from '@/design/components';
import type { PreviewResponse } from '@/lib/types';

/**
 * Natural layout width the engine email is designed for (a 480px card inside a
 * full-width wrapper). We render the iframe at this width and scale it down to
 * the panel so the email never overflows horizontally. A little headroom over
 * 480 absorbs the default body margins around the card.
 */
const EMAIL_WIDTH = 500;

/**
 * Bottom sheet showing the exact branded email (the real engine template,
 * rendered server-side), with Cancel / Send beneath it.
 *
 * The HTML is rendered in an iframe sandboxed with `allow-same-origin` only —
 * scripts are NOT allowed, so the email stays inert and can't touch the panel;
 * same-origin just lets us read its rendered size to fit it. We lay the iframe
 * out at the email's natural width and CSS-scale it down to the panel width, so
 * the only scrollbar is the sheet's own vertical one (and that disappears too
 * when the email is short enough to fit).
 */
export function PreviewSheet({
  preview,
  recipient,
  totalCount,
  update = false,
  sending,
  onSend,
  onClose,
}: {
  preview: PreviewResponse;
  recipient: string;
  totalCount: number;
  /** Managed event: we're updating already issued passes, not sending new ones.
   *  Switches the count wording from "sent" to "updated" so the host sees exactly
   *  how many passes their change touches (editing one guest of five reads "1"). */
  update?: boolean;
  sending: boolean;
  onSend: () => void;
  onClose: () => void;
}) {
  const verb = update ? 'updated' : 'sent';
  const action = update ? 'Update' : 'Send';
  const scrollRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Width the email lays out at (clamped so we never shrink below the panel).
  const [contentWidth, setContentWidth] = useState(EMAIL_WIDTH);
  // Natural rendered height of the email; null until the iframe has loaded.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  // Panel width available for the preview, tracked so we rescale on resize.
  const [viewportWidth, setViewportWidth] = useState(0);

  const measure = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (doc) {
      const root = doc.documentElement;
      // Kill the iframe's own scrollbar — all scrolling is handled by the
      // outer wrapper.  We must read dimensions *before* forcing overflow
      // hidden, otherwise scrollHeight collapses.
      const w = Math.max(EMAIL_WIDTH, root.scrollWidth);
      const h = root.scrollHeight;
      root.style.overflow = 'hidden';
      if (doc.body) doc.body.style.overflow = 'hidden';
      setContentWidth(w);
      setContentHeight(h);
    }
    if (scrollRef.current) setViewportWidth(scrollRef.current.clientWidth);
  }, []);

  // Keep the scale in sync with the panel width.
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    setViewportWidth(scrollRef.current.clientWidth);
    const ro = new ResizeObserver(() => measure());
    ro.observe(scrollRef.current);
    return () => ro.disconnect();
  }, [measure]);

  const scale = viewportWidth > 0 ? Math.min(1, viewportWidth / contentWidth) : 1;
  const scaledHeight = contentHeight != null ? contentHeight * scale : null;

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
          maxHeight: '94%',
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

        <div
          ref={scrollRef}
          style={{
            flex: 1,
            minHeight: 280,
            overflowY: 'auto',
            overflowX: 'hidden',
            background: '#fff',
          }}
        >
          <div
            style={{
              width: '100%',
              // Reserve exactly the scaled height so there's no internal scroll
              // and no dead space below a short email.
              height: scaledHeight ?? undefined,
              overflow: 'hidden',
            }}
          >
            <iframe
              ref={iframeRef}
              title="Email preview"
              sandbox="allow-same-origin"
              srcDoc={preview.html}
              onLoad={measure}
              style={{
                border: 'none',
                background: '#fff',
                display: 'block',
                width: contentWidth,
                height: contentHeight ?? 280,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
              }}
            />
          </div>
        </div>

        <footer
          style={{
            display: 'grid',
            gap: 'var(--space-sm)',
            padding: 'var(--space-md) var(--space-lg)',
            borderTop: '1px solid var(--color-outline-variant)',
          }}
        >
          <div className="type-label-sm text-muted" style={{ textAlign: 'center' }}>
            Preview for {recipient} · {totalCount} pass{totalCount > 1 ? 'es' : ''} will be{' '}
            {verb}
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
              {sending
              ? update
                ? 'Updating…'
                : 'Sending…'
              : `${action} ${totalCount} pass${totalCount > 1 ? 'es' : ''}`}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
