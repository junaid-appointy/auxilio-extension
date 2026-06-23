import { useEffect, useState } from 'react';
import { ChevronDown, Phone, User } from 'lucide-react';
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
  // Details stay collapsed by default so each card is compact; the host opens
  // them only to make a correction. Sent guests are editable too — re-sending
  // pushes the change onto the already-issued pass.
  const [editing, setEditing] = useState(false);

  // Keep local inputs in sync when the server reconciles the row.
  useEffect(() => setName(guest.name), [guest.name]);
  useEffect(() => setPhone(guest.phone ?? ''), [guest.phone]);

  const sent = guest.status === 'sent';
  const cancelled = guest.status === 'cancelled';
  const display = guest.name || guest.email;
  // A sent guest toggled OFF is a pending cancel — re-sending will revoke their
  // pass (engine applyDraft cancels !include guests with an active pass), so we
  // dim the row and don't offer edits. Everyone we'd still issue/update a pass
  // for can be corrected, whether or not their pass already went out.
  const pendingCancel = sent && !guest.include;
  const editable = guest.include && !cancelled;

  // Switch is no longer locked once a pass is sent: toggling off cancels on the
  // next update (mirrors the add-on), toggling back on re-issues.
  const switchLabel = sent
    ? guest.include
      ? `Cancel the pass for ${guest.email}`
      : `Re-issue a pass for ${guest.email}`
    : guest.include
      ? `Don’t invite ${guest.email}`
      : `Invite ${guest.email}`;

  return (
    <div className={`guest${guest.include ? '' : ' guest--dim'}`}>
      <div className="guest__head">
        <span
          className={
            'guest__avatar' +
            (pendingCancel
              ? ' guest__avatar--dim'
              : sent
                ? ' guest__avatar--sent'
                : guest.include
                  ? ''
                  : ' guest__avatar--dim')
          }
          aria-hidden
        >
          {monogram(guest.name || guest.email.split('@')[0])}
        </span>

        <div className="guest__id">
          <div className="guest__name">
            <span className="type-label row__ellipsis">{display}</span>
            {guest.internal && !sent && !cancelled && <Chip>Internal</Chip>}
            {sent && guest.include && <Chip tone="success">Pass sent</Chip>}
            {pendingCancel && <Chip tone="error">Will cancel</Chip>}
            {cancelled && <Chip tone="error">Cancelled</Chip>}
          </div>
          <div className="type-label-sm text-muted row__ellipsis">{guest.email}</div>
        </div>

        <Switch
          checked={guest.include}
          onChange={(v) => onChange({ include: v })}
          label={switchLabel}
        />
      </div>

      {editable ? (
        // Full-bleed "scroll" drawer pinned to the card's bottom edge: a subtle,
        // edge-to-edge handle the host pulls open only when they need to correct
        // a detail — keeps each card compact by default.
        <div className={`guest__drawer${editing ? ' guest__drawer--open' : ''}`}>
          <button
            type="button"
            className="guest__handle"
            aria-expanded={editing}
            onClick={() => setEditing((v) => !v)}
          >
            <ChevronDown size={16} strokeWidth={2} className="guest__chev" />
            {editing ? 'Hide details' : guest.phone ? 'Edit details' : 'Add phone & name'}
          </button>
          {editing && (
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
              {sent && (
                <div className="type-label-sm text-muted">
                  Re-send to push this change onto the pass already issued.
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        !guest.include &&
        !cancelled && (
          <div className="guest__hint type-label-sm">Will not receive a pass. Toggle on to invite.</div>
        )
      )}
    </div>
  );
}
