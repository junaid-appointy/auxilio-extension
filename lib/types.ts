/**
 * Engine domain types — mirror office-ops-engine visit-drafts.ts + the
 * /addon/* route responses exactly. Keep in sync with that module.
 */

export type DraftGuestStatus = 'pending' | 'sending' | 'sent' | 'cancelled';

/** Pass-linkage state of a calendar event, for the injected row's dynamic copy:
 *  - 'sent'    = passes already issued (this extension OR another surface);
 *  - 'pending' = a magic-address visitor event with no passes yet;
 *  - 'plain'   = an ordinary / brand-new event we know nothing about.
 *  Resolved from local background state (instant, no network). */
export type EventState = 'sent' | 'pending' | 'plain';

export interface DraftGuest {
  email: string;
  name: string;
  /** True when `name` is the email-derived fallback, not a real display name
   *  (Google omits displayName for external non-contact guests). Drives the card's
   *  avatar/label and is cleared once the contacts resolver finds a real name. */
  nameIsFallback?: boolean;
  /** Profile photo URL when resolved (People API). Falls back to a monogram. */
  photoUrl?: string;
  phone?: string;
  /** Host include/exclude toggle. */
  include: boolean;
  /** Display hint: internal same-workspace colleague (toggle starts OFF). */
  internal?: boolean;
  passTemplateKey?: string;
  emailTemplateKey?: string;
  status: DraftGuestStatus;
  invitationId?: string;
  /** Transient read-only check-in annotations from the engine (NOT persisted): the
   *  guest has arrived at reception. `checkedInside` = still inside (not checked out). */
  checkedIn?: boolean;
  checkedInside?: boolean;
  checkinTime?: string;
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
  /** Already-issued passes whose details (name/phone) were updated + email resent. */
  updated?: { visitorEmail: string; invitationId: string; changedFields: string[] }[];
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

/** A guest's real name + profile photo resolved from the host's Google contacts
 *  (People API), mirroring how Calendar's web UI shows names the event API omits. */
export interface ResolvedPerson {
  name?: string;
  photoUrl?: string;
}

/** A visitor (magic-address) event surfaced by the sync poll — for the
 *  "open from list" picker and notifications. `eid` resolves like a clicked one. */
export interface VisitorEventSummary {
  eid: string;
  eventId: string;
  iCalUid: string;
  title: string;
  start?: string;
  /** Parent series id for a recurring instance (else the event's own id). Lets a
   *  recurring series be treated as one nudge unit — one badge, one notification,
   *  one picker row showing the soonest pending occurrence. */
  seriesId?: string;
}

/** A visitor event as shown on the side-panel homescreen — a MANAGEMENT surface,
 *  so unlike the nag surfaces (badge/notification/in-page banner) it also lists
 *  events whose passes are already sent, tagged `status:'sent'`, so the host can
 *  reopen them to update or cancel. */
export interface PanelVisitorEvent extends VisitorEventSummary {
  /** 'pending' = still needs passes; 'sent' = passes already issued (this
   *  extension, the add-on, or another device). */
  status: 'pending' | 'sent';
}
