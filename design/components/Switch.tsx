import { Check } from 'lucide-react';

/** MD3 switch. Controlled; instant visual feedback (optimistic at call site).
 *  The thumb carries a check glyph when on — MD3's signature "selected" cue,
 *  so the state reads at a glance instead of relying on colour alone. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb">
        <Check className="switch__check" size={11} strokeWidth={3.5} />
      </span>
    </button>
  );
}
