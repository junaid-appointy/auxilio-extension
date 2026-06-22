/**
 * Engine domain types — mirror office-ops-engine visit-drafts.ts + the
 * /addon/* route responses exactly. Keep in sync with that module.
 */

export type DraftGuestStatus = 'pending' | 'sending' | 'sent' | 'cancelled';

export interface DraftGuest {
  email: string;
  name: string;
  phone?: string;
  /** Host include/exclude toggle. */
  include: boolean;
  /** Display hint: internal same-workspace colleague (toggle starts OFF). */
  internal?: boolean;
  passTemplateKey?: string;
  emailTemplateKey?: string;
  status: DraftGuestStatus;
  invitationId?: string;
}

export interface VisitDraft {
  iCalUid: string;
  tenantId: string;
  providerEventId?: string;
  title?: string;
  hostEmail?: string;
  location?: string;
  roster: DraftGuest[];
  eventStart?: string;
  eventEnd?: string;
  materialized: boolean;
}

export interface DraftPatch {
  location?: string;
  guests?: {
    email: string;
    include?: boolean;
    name?: string;
    phone?: string;
    passTemplateKey?: string;
    emailTemplateKey?: string;
  }[];
}

export interface EmailTemplate {
  key: string;
  name: string;
  isDefault: boolean;
}

export interface CalendarSync {
  connected: boolean;
  canConnect: boolean;
  relevant: boolean;
  connectUrl?: string;
}

/** POST /addon/draft response = VisitDraft + extras. */
export interface DraftResponse extends VisitDraft {
  calendarSync: CalendarSync;
  emailTemplates: EmailTemplate[];
}

/** POST /addon/preview response. */
export interface PreviewResponse {
  subject: string;
  html: string;
  text: string;
  previewToken: string;
}

export interface PassResult {
  visitorEmail: string;
  visitorName: string;
  invitationId: string;
  passUrl: string;
  status: 'sent';
}

/** POST /addon/send response (route-wrapped ApplyResult). */
export interface SendResponse {
  iCalUid: string;
  created: PassResult[];
  cancelled: { visitorEmail: string; invitationId: string }[];
  failed: { visitorEmail: string; reason: string }[];
  activeCount: number;
  draft: VisitDraft;
}

/** The active Calendar event the side panel is working on (API-authoritative). */
export interface ActiveEvent {
  iCalUid: string;
  providerEventId?: string;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
  /** Room/resource attendees (resource: true), by display name or email. */
  rooms?: string[];
  organizerEmail?: string;
  attendees: { email: string; name?: string }[];
}

/**
 * Best-effort snapshot read from the open event's DOM by the content script.
 * Instant + works pre-save, but not authoritative — the API reconciles it.
 */
export interface DomEventSnapshot {
  eid: string;
  /** Magic address present among the visible guests → a visitor event. */
  magicPresent: boolean;
  /** Guest emails scraped from the open surface (may be partial). */
  guestEmails: string[];
  title?: string;
}

export interface AuthStatus {
  signedIn: boolean;
  email?: string;
}

/** A visitor (magic-address) event surfaced by the sync poll — for the
 *  "open from list" picker and notifications. `eid` resolves like a clicked one. */
export interface VisitorEventSummary {
  eid: string;
  eventId: string;
  iCalUid: string;
  title: string;
  start?: string;
}
