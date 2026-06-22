import { useEffect, useState } from 'react';
import { Phone, User } from 'lucide-react';
import { Chip, Switch, TextField } from '@/design/components';
import type { DraftGuest } from '@/lib/types';

type GuestEdit = {
  include?: boolean;
  name?: string;
  phone?: string;
};

/** Two-letter monogram from a name ("Jane Doe" → "JD") or an email local-part
 *  ("jane.doe@x" → "JD"), so each guest has a stable, recognisable avatar. */
function monogram(seed: string): string {
  const parts = seed.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function RosterRow({
  guest,
  onChange,
}: {
  guest: DraftGuest;
  onChange: (edit: GuestEdit) => void;
}) {
  const [name, setName] = useState(guest.name);
  const [phone, setPhone] = useState(guest.phone ?? '');

  // Keep local inputs in sync when the server reconciles the row.
  useEffect(() => setName(guest.name), [guest.name]);
  useEffect(() => setPhone(guest.phone ?? ''), [guest.phone]);

  const sent = guest.status === 'sent';
  const cancelled = guest.status === 'cancelled';
  const display = guest.name || guest.email;
  const editable = guest.include && !sent;

  return (
    <div className={`guest${guest.include ? '' : ' guest--dim'}`}>
      <div className="guest__head">
        <span
          className={
            'guest__avatar' +
            (sent ? ' guest__avatar--sent' : guest.include ? '' : ' guest__avatar--dim')
          }
          aria-hidden
        >
          {monogram(guest.name || guest.email.split('@')[0])}
        </span>

        <div className="guest__id">
          <div className="guest__name">
            <span className="type-label row__ellipsis">{display}</span>
            {guest.internal && !sent && <Chip>Internal</Chip>}
            {sent && <Chip tone="success">Pass sent</Chip>}
            {cancelled && <Chip tone="error">Cancelled</Chip>}
          </div>
          <div className="type-label-sm text-muted row__ellipsis">{guest.email}</div>
        </div>

        <Switch
          checked={guest.include}
          disabled={sent}
          onChange={(v) => onChange({ include: v })}
          label={`${guest.include ? 'Don’t invite' : 'Invite'} ${guest.email}`}
        />
      </div>

      {editable ? (
        <div className="guest__form">
          <TextField
            label="Visitor name"
            value={name}
            leadingIcon={<User size={16} strokeWidth={2} />}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== guest.name && onChange({ name })}
            placeholder="Full name"
          />
          <TextField
            label="Phone (for WhatsApp pass)"
            value={phone}
            inputMode="tel"
            leadingIcon={<Phone size={16} strokeWidth={2} />}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => phone !== (guest.phone ?? '') && onChange({ phone })}
            placeholder="+91…"
          />
        </div>
      ) : (
        !guest.include &&
        !cancelled && (
          <div className="guest__hint type-label-sm">Won’t receive a pass — toggle on to invite</div>
        )
      )}
    </div>
  );
}
