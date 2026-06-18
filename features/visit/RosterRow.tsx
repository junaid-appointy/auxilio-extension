import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { Chip, IconButton, SelectField, Spinner, Switch, TextField } from '@/design/components';
import type { DraftGuest, EmailTemplate } from '@/lib/types';

type GuestEdit = {
  include?: boolean;
  name?: string;
  phone?: string;
  emailTemplateKey?: string;
};

export function RosterRow({
  guest,
  templates,
  onChange,
  onPreview,
  previewing,
}: {
  guest: DraftGuest;
  templates: EmailTemplate[];
  onChange: (edit: GuestEdit) => void;
  onPreview: () => void;
  previewing: boolean;
}) {
  const [name, setName] = useState(guest.name);
  const [phone, setPhone] = useState(guest.phone ?? '');

  // Keep local inputs in sync when the server reconciles the row.
  useEffect(() => setName(guest.name), [guest.name]);
  useEffect(() => setPhone(guest.phone ?? ''), [guest.phone]);

  const sent = guest.status === 'sent';
  const cancelled = guest.status === 'cancelled';
  const defaultTemplate = templates.find((t) => t.isDefault)?.key ?? templates[0]?.key;

  return (
    <div className={`row${guest.include ? '' : ' row--dim'}`}>
      <Switch
        checked={guest.include}
        disabled={sent}
        onChange={(v) => onChange({ include: v })}
        label={`Invite ${guest.email}`}
      />

      <div className="row__grow">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="type-label row__ellipsis" style={{ flex: '0 1 auto' }}>
            {guest.name || guest.email}
          </span>
          {guest.internal && !sent && <Chip>Internal</Chip>}
          {sent && <Chip tone="success">Pass sent</Chip>}
          {cancelled && <Chip tone="error">Cancelled</Chip>}
        </div>
        <div className="type-label-sm text-muted row__ellipsis">{guest.email}</div>

        {guest.include && !sent && (
          <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
            <TextField
              label="Visitor name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name !== guest.name && onChange({ name })}
              placeholder="Full name"
            />
            <TextField
              label="Phone (for WhatsApp pass)"
              value={phone}
              inputMode="tel"
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => phone !== (guest.phone ?? '') && onChange({ phone })}
              placeholder="+91…"
            />
            {templates.length >= 2 && (
              <SelectField
                label="Email template"
                value={guest.emailTemplateKey ?? defaultTemplate}
                onChange={(e) => onChange({ emailTemplateKey: e.target.value })}
              >
                {templates.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                    {t.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </SelectField>
            )}
          </div>
        )}
      </div>

      <IconButton label="Preview email" onClick={onPreview} disabled={previewing}>
        {previewing ? <Spinner /> : <Eye size={18} strokeWidth={2} />}
      </IconButton>
    </div>
  );
}
