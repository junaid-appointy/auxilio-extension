import { useEffect, useRef, useState } from 'react';
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

  // Reconcile server/background updates WITHOUT clobbering a live edit: adopt the
  // new server value only when the local field still equals the last server value
  // we saw (the host hasn't typed over it). So a background name/photo resolve fills
  // an untouched field, but a half-typed correction is never lost. (See the contacts
  // name-resolution flow — the name can change after first paint.)
  // Capture the PREVIOUS server value before mutating the ref: setName's functional
  // updater runs lazily (next commit), so reassigning the ref first would make the
  // updater compare against the new value and never adopt it. Snapshot prev, point
  // the ref at the new value, then compare the updater's local to that snapshot.
  const lastServerName = useRef(guest.name);
  useEffect(() => {
    const prev = lastServerName.current;
    lastServerName.current = guest.name;
    setName((local) => (local === prev ? guest.name : local));
  }, [guest.name]);

  const lastServerPhone = useRef(guest.phone ?? '');
  useEffect(() => {
    const next = guest.phone ?? '';
    const prev = lastServerPhone.current;
    lastServerPhone.current = next;
    setPhone((local) => (local === prev ? next : local));
  }, [guest.phone]);

  // Commit name/phone edits as the host TYPES (debounced), not only on blur, so the
  // Review button reflects the change right away and the edit is persisted sooner —
  // it can't be "lost" by a re-render before a blur ever fires (the reported bug).
  // Blur flushes any pending debounce immediately. onChange is idempotent per field,
  // so a flush after a debounce that already ran is a harmless no-op.
  const nameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const phoneTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(nameTimer.current);
      clearTimeout(phoneTimer.current);
    },
    [],
  );
  const commitName = (v: string) => {
    clearTimeout(nameTimer.current);
    nameTimer.current = setTimeout(() => {
      if (v !== guest.name) onChange({ name: v });
    }, 500);
  };
  const flushName = (v: string) => {
    clearTimeout(nameTimer.current);
    if (v !== guest.name) onChange({ name: v });
  };
  const commitPhone = (v: string) => {
    clearTimeout(phoneTimer.current);
    phoneTimer.current = setTimeout(() => {
      if (v !== (guest.phone ?? '')) onChange({ phone: v });
    }, 500);
  };
  const flushPhone = (v: string) => {
    clearTimeout(phoneTimer.current);
    if (v !== (guest.phone ?? '')) onChange({ phone: v });
  };

  const sent = guest.status === 'sent';
  const cancelled = guest.status === 'cancelled';
  const display = guest.name || guest.email;
  // A sent guest toggled OFF is a pending cancel — re-sending will revoke their
  // pass (engine applyDraft cancels !include guests with an active pass), so we
  // dim the row and don't offer edits. Everyone we'd still issue/update a pass
  // for can be corrected, whether or not their pass already went out.
  const pendingCancel = sent && !guest.include;
  const editable = guest.include && !cancelled;

  // The drawer handle names exactly what's still missing, so the host knows what
  // tapping it is for. A real name is absent when the engine flagged the name as the
  // email-derived fallback; phone is absent when blank.
  const hasName = !guest.nameIsFallback;
  const hasPhone = !!guest.phone?.trim();
  const drawerLabel = editing
    ? 'Hide details'
    : hasName && hasPhone
      ? 'Edit details'
      : !hasName && !hasPhone
        ? 'Add phone and name'
        : hasPhone
          ? 'Add name'
          : 'Add phone';

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
          {guest.photoUrl ? (
            <img className="guest__photo" src={guest.photoUrl} alt="" loading="lazy" />
          ) : (
            monogram(guest.name || guest.email.split('@')[0])
          )}
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
            {drawerLabel}
          </button>
          {editing && (
            <div className="guest__form">
              <TextField
                label="Visitor name"
                value={name}
                leadingIcon={<User size={16} strokeWidth={2} />}
                onChange={(e) => {
                  setName(e.target.value);
                  commitName(e.target.value);
                }}
                onBlur={() => flushName(name)}
                placeholder="Full name"
              />
              <TextField
                label="Phone"
                value={phone}
                inputMode="tel"
                leadingIcon={<Phone size={16} strokeWidth={2} />}
                onChange={(e) => {
                  setPhone(e.target.value);
                  commitPhone(e.target.value);
                }}
                onBlur={() => flushPhone(phone)}
                placeholder="+91…"
              />
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
