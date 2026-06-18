import type { HTMLAttributes } from 'react';

/** Surface container with MD3 outline + radius. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={['card', className ?? ''].join(' ')} {...rest} />;
}
