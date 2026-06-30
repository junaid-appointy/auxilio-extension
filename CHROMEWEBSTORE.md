# Chrome Web Store Listing — Auxilio Visitor

> Last Updated: 2026-06-29

## Store Listing

**Extension Name** [REQUIRED]
Auxilio Visitor


**Short Description** [REQUIRED]
Register office visitors directly from a Google Calendar event.


**Detailed Description** [REQUIRED]
Auxilio Visitor streamlines workplace operations by allowing you to register office visitors directly from Google Calendar events.

Key Features:
Seamless Google Calendar integration that inserts a native-styled "Manage Visitors" button into event creation, edit, and detail views.
Automatic extraction and resolution of guest details and emails directly from the calendar invite.
Instant registration of visitors with the Auxilio Office Operations platform to generate and send entry passes.
Persistent side panel interface for full visitor management and status tracking without leaving your calendar workflow.

How to Use It:
1. Install the extension and open Google Calendar.
2. Open any upcoming meeting or create a new event.
3. Click the "Manage Visitors" row or button in the event details section.
4. The Auxilio side panel will open, allowing you to register guests and issue entry passes in one click.

Privacy & Security:
Auxilio Visitor is built with enterprise security in mind. It operates strictly within Google Calendar and communicates securely with your designated Auxilio Office Operations engine. It requires only the minimum necessary permissions to identify event attendees and manage side panel interactions.

Support & Feedback:
For enterprise support or feedback, please contact your workplace operations administrator or reach out to support@auxilio.com.


**Category** [REQUIRED]
Productivity


**Single Purpose** [REQUIRED]
Register office visitors and issue entry passes directly from Google Calendar events.


**Primary Language** [REQUIRED]
English


## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icon/128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ✅ Ready | `screenshot-calendar-popover.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ✅ Ready | `screenshot-sidepanel-manage.png` |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ✅ Ready | `screenshot-event-edit.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 | ✅ Ready | `promo-tile-440.png` |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

### Screenshot Notes
- **Screenshot 1**: Demonstrates the native-styled "Manage Visitors" content row inside the Google Calendar event detail popover.
- **Screenshot 2**: Shows the Auxilio side panel open alongside Google Calendar, displaying active visitors and passes.
- **Screenshot 3**: Showcases the "Manage Visitors" native content row integrated perfectly into the full event edit page's Event Details section.


## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `identity` | permissions | Required to securely authenticate the user via Google OAuth (`chrome.identity.launchWebAuthFlow`) with the Auxilio backend engine. |
| `sidePanel` | permissions | Required to display the main visitor management interface in a side panel alongside Google Calendar without interrupting the user's scheduling workflow. |
| `storage` | permissions | Required to persist user session tokens and cache visitor pass configuration locally. |
| `alarms` | permissions | Required to periodically refresh authentication tokens and maintain background synchronization with the Auxilio engine. |
| `notifications` | permissions | Required to alert the user when visitor passes are successfully issued or if a guest check-in requires urgent attention. |
| `https://calendar.google.com/*` | host_permissions | Required to inject the "Manage Visitors" button and content rows into Google Calendar event creation, edit, and detail popover surfaces. |
| `https://www.googleapis.com/*` | host_permissions | Required to securely query Google Calendar event metadata and attendee details for visitor pre-registration. |
| `https://people.googleapis.com/*` | host_permissions | Required to fetch attendee display names and profile photos for accurate visitor pass generation. |
| `https://ops-engine-dev-330299.bifrost.saastack.site/*` | host_permissions | Required to securely communicate with the Auxilio Office Operations backend engine to register visitors and issue entry passes. |


## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | Yes | Yes | Used to identify the meeting host and visitors (attendee email/names) to issue secure office entry passes. | No |
| Authentication info | Yes | Yes | OAuth tokens used to securely authenticate with the Auxilio backend engine. | No |
| User activity | Yes | Yes | Tracks visitor registration requests initiated by the user to maintain workplace compliance logs. | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes


## Privacy Policy

**Privacy Policy URL** [REQUIRED]
https://auxilio.com/privacy


## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free


## Developer Info

**Publisher Name** [REQUIRED]
Auxilio Office Operations

**Contact Email** [REQUIRED]
support@auxilio.com

**Support URL / Email** [RECOMMENDED]
support@auxilio.com

**Homepage URL** [RECOMMENDED]
https://auxilio.com


## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.11.34 | 2026-06-29 | Refactored Google Calendar UI injection to perfectly mirror native padding, 20x20 icons, and dynamic link blue colors in event details and popover views. | Draft |
