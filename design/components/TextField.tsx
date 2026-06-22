import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Optional leading glyph (Lucide icon) rendered inside the input. */
  leadingIcon?: ReactNode;
}

/** Slim filled text input. */
export function TextField({ label, id, className, leadingIcon, ...rest }: TextFieldProps) {
  const input = (
    <input
      id={id}
      className={['field__input', leadingIcon ? 'field__input--with-icon' : '', className ?? ''].join(' ')}
      {...rest}
    />
  );
  return (
    <label className="field" htmlFor={id}>
      {label && <span className="field__label">{label}</span>}
      {leadingIcon ? (
        <span className="field__wrap">
          <span className="field__icon" aria-hidden>
            {leadingIcon}
          </span>
          {input}
        </span>
      ) : (
        input
      )}
    </label>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  children: ReactNode;
}

/** Native select styled to match the field. Used for ≥2 template choices. */
export function SelectField({ label, id, children, className, ...rest }: SelectFieldProps) {
  return (
    <label className="field" htmlFor={id}>
      {label && <span className="field__label">{label}</span>}
      <select
        id={id}
        className={['field__input', className ?? ''].join(' ')}
        {...rest}
      >
        {children}
      </select>
    </label>
  );
}
