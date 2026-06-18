import type { ReactNode } from 'react';

type Tone = 'neutral' | 'success' | 'error';

/** Compact status badge. */
export function Chip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip chip--${tone}`}>{children}</span>;
}
