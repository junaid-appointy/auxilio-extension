import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

/** Round icon-only button (lucide icon as children). */
export function IconButton({ label, children, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={['icon-btn', className ?? ''].join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}
