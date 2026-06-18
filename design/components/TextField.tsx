import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

/** Slim filled text input. */
export function TextField({ label, id, className, ...rest }: TextFieldProps) {
  return (
    <label className="field" htmlFor={id}>
      {label && <span className="field__label">{label}</span>}
      <input
        id={id}
        className={['field__input', className ?? ''].join(' ')}
        {...rest}
      />
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
