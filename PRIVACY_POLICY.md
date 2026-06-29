# Privacy Policy — Auxilio Visitor (Chrome Extension)

_Last updated: 26 June 2026_

Auxilio Visitor ("the extension") is an internal tool that lets a meeting host
register in-person office visitors directly from a Google Calendar event. This
policy explains what data the extension accesses, why, and how it is handled.

## Who this is for

The extension is distributed for internal use within our organization. It is not
a general-public consumer product.

## What data we access

- **Your Google account identity** — your email address and name, obtained when
  you sign in, to authenticate you to our Auxilio backend and to authorize
  reading the calendar event you have open.
- **Google Calendar event data (read-only)** — the title, date/time, location,
  and attendee list of the event you are actively viewing, used to build the
  visitor roster. The extension requests only the
  `calendar.events.readonly` scope. It never requests Gmail or Drive access.
- **Visitor details you enter** — guest names and phone numbers you add or
  correct in order to issue a pass.
- **Contact display names/photos** — resolved from your Google contacts (People
  API) to label guests in the roster.
- **Authentication tokens** — short-lived OAuth tokens used to make the above
  requests.

## How we use it

This data is used solely to register visitors and issue visitor passes through
your organization's Auxilio backend. It is not used for advertising, profiling,
or any purpose unrelated to that single function.

## How it is shared

- Event and visitor details are sent to your organization's Auxilio backend
  (operated by us) to create and send visitor passes.
- We do **not** sell or rent your data, and we do **not** share it with third
  parties outside the visitor-pass workflow.

## Storage and retention

- OAuth tokens and the currently-open event context are kept in the browser's
  session storage and are cleared when the browser closes.
- Visitor and event records created when you issue a pass are stored by the
  Auxilio backend for operational and audit purposes, under your organization's
  data-retention practices.

## Your choices

- You can sign out from the extension at any time, which clears the local
  session.
- You can revoke the extension's access to your Google account at
  https://myaccount.google.com/permissions.

## Contact

Questions about this policy: privacy@appointy.com
