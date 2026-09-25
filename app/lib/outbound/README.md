# Outbound providers

## What the Apollo API actually allows

Researched via Apollo's public developer docs (read only, API never called
from this repo: no key is configured here and none should ever be added
without the principal knowing exactly what it does).

- `POST /api/v1/emailer_messages` ("Create an Email Draft"):
  https://docs.apollo.io/reference/create-an-email-draft
  Accepts `contact_id`, `subject`, `body_html`, and drafts the message from
  the email account that owns the API key. The subject and body are
  arbitrary: they are not required to belong to any sequence or template
  stored in Apollo.
- `POST /api/v1/emailer_messages/send_now/{id}` ("Send Email Now"):
  https://docs.apollo.io/reference/send-email-now
  Sends the exact drafted message by id. Takes no content, only the id.
- For comparison, the sequence-enrollment path (NOT used here):
  `POST /api/v1/emailer_campaigns/{sequence_id}/add_contact_ids`
  (https://docs.apollo.io/reference/add-contacts-to-sequence) and sequence
  step templates created via
  `POST /api/v1/emailer_campaigns` (https://docs.apollo.io/reference/create-sequence),
  where each `emailer_touch.emailer_template` holds its own subject/body_html
  stored inside Apollo, separate from anything in this app.

## What this app implements

`ApolloProvider.send()` in `provider.ts` uses the first path: draft, then
send-now, with the exact `subject` and `body` this app already rendered and
compliance-checked (approved template + allow-listed merge fields + the
legal footer). The text a recipient receives is the text this harness
produced and re-verified in `checkSend`, nothing else.

The sequence-enrollment path is not implemented, so there is nothing that
requires an `apollo_sequence_id` mapping on a template, and no separate copy
stored in Apollo that could drift from what was approved. `verifySequenceCopy()`
is kept only as a defensive placeholder in case a future integration is
built the other way (enrolling into a sequence whose copy lives in Apollo,
which would then need the principal to approve the Apollo sequence step
itself, kept identical to the CRM's copy, and checked at send time before
this app could ever trust it).

## Gating

`ApolloProvider` refuses to construct unless ALL of the following are true:
`OUTBOUND_PROVIDER === "apollo"`, `OUTBOUND_SEND_ENABLED === "1"`, and
`APOLLO_API_KEY` / `APOLLO_SEQUENCE_ID` / `APOLLO_EMAIL_ACCOUNT_ID` are all
set. `getProvider()` falls back to `DryRunProvider` on any failure to
construct, so a half-configured environment can never send for real.
`APOLLO_SEQUENCE_ID` is required as a fourth explicit switch but is not
passed to the draft/send-now calls, since this provider never enrolls a
contact into a sequence.

## SmtpProvider

`SmtpProvider` is an unimplemented stub for a bank that wants to plug in its
own mail system instead of Apollo. Its `send()` always throws
`"not configured"`. Wiring a real transport in is a deployment decision for
whoever resells this harness, not made here.

## Tests

`DryRunProvider` is the only provider exercised by the test suite. Every
provider test stubs global `fetch` to throw, so any accidental real network
call fails the test loudly instead of silently reaching Apollo.

## InstantlyProvider (Deal Desk approves, Instantly sends)

Endpoints, verified against the live Instantly API v2 docs on 2026-09-25
(base `https://api.instantly.ai`, auth `Authorization: Bearer <INSTANTLY_API_KEY>`):

| Use | Endpoint | Doc |
| --- | --- | --- |
| Push an approved message's lead into the campaign | `POST /api/v2/leads` | https://developer.instantly.ai/api-reference/lead/create-lead |
| Read replies (Unibox) since the cursor | `GET /api/v2/emails?email_type=received&min_timestamp_created=...&sort_order=asc` | https://developer.instantly.ai/api-reference/email/list-email |
| Campaign lookup | `GET /api/v2/campaigns/{id}`, `GET /api/v2/campaigns` | https://developer.instantly.ai/api-reference/campaign/get-campaign, https://developer.instantly.ai/api-reference/campaign/list-campaign |
| Sending mailboxes (daily limit, warmup start) | `GET /api/v2/accounts` | https://developer.instantly.ai/api-reference/account/list-account |
| Lead interest status (not called automatically) | `POST /api/v2/leads/update-interest-status` | https://developer.instantly.ai/api-reference/lead/update-the-interest-status-of-a-lead |

How a message goes out:

1. A principal approves the template (hash-bound, as for every provider).
2. The owner runs the send (`POST /api/outbound/run`). `checkSend` runs first,
   unchanged: hash + approval, re-render match, lint, suppression,
   do_not_contact, unsubscribed, never re-email a replier, 7-day spacing,
   mailbox cap, `OUTBOUND_SEND_ENABLED=1`.
3. Only on a clean pass, `InstantlyProvider.send()` adds the recipient to ONE
   Instantly campaign with `first_name`, `last_name`, `company_name`, and the
   approved rendered text as `custom_variables.subject` and
   `custom_variables.body` (footer with postal address and unsubscribe link
   included). `skip_if_in_campaign: true` means a lead already in the campaign
   is never added twice.
4. The campaign has a single step whose subject is `{{subject}}` and whose
   body is `{{body}}`, and nothing else, so Instantly sends exactly the
   approved text. Deal Desk itself sends nothing.
5. The exact pushed text is written to `outbound_pushes` (insert-only) and to
   the contact timeline as "Sent via Instantly".

Gating: `InstantlyProvider` refuses to construct unless ALL of
`OUTBOUND_SEND_ENABLED=1`, `OUTBOUND_PROVIDER=instantly`, `INSTANTLY_API_KEY`
and `INSTANTLY_CAMPAIGN_ID` are set. `getProvider()` falls back to
`DryRunProvider` on any miss. Reads (reply poll, mailbox pull) need only
`INSTANTLY_API_KEY`.

Mailbox caps: Instantly picks which of the campaign's mailboxes sends each
email, so per-mailbox attribution in Deal Desk is nominal. The cap math stays
honest because the Mailboxes page records each Instantly mailbox with its
daily cap (pulled from `daily_limit` or typed in), and a recorded cap can only
lower the warmup ramp, never raise it. Set the campaign's own daily limit in
Instantly no higher than the sum shown on the Mailboxes page.

Replies: polled, not webhooked (Deal Desk runs on localhost, which Instantly
cannot reach). The Replies page button "Check Instantly for replies" (owner
only) and `node scripts/poll-instantly-replies.mjs` both run
`pollInstantlyReplies()`, which reads received emails since the stored cursor
(`sync_cursors.instantly.replies`), and for each one: stores it with its full
text in `inbound_replies` (idempotent on `instantly:<email id>`), writes the
full text to the contact timeline, applies the replier rule (the send gate
never emails a contact with a reply on record, and anything queued is
cancelled), and opens a first-stage deal "<Company>: replied to outreach" if
the company has no open deal. Instantly's own `is_auto_reply` flag (plus the
existing subject heuristics) marks out-of-office mail, which is stored but
opens no deal and does not count as a reply. Classification reads only the
replier's own words, never the quoted thread, so our own footer's
unsubscribe link in a quote cannot turn a reply into an unsubscribe.

Set the campaign's "stop on reply" on in Instantly as a second guard, so
Instantly stops its own sequence the moment a lead replies, even before the
next poll.

### Shared Instantly account

The Instantly workspace configured here may be SHARED with another tenant
(for example an agency running its own campaigns and sending domains).
Two env vars keep this harness from ever touching that tenant's mailboxes, replies,
or leads, and both fail closed (unset or empty means "import/poll nothing",
never "import/poll everything"):

- `INSTANTLY_ALLOWED_DOMAINS` - comma list of the firm's own sending domains
  (e.g. `yourfirm-mail.example,yourfirmadvisory.example`), matched case-insensitively
  as an exact domain, never a substring. "Pull mailboxes from Instantly" on
  the Mailboxes page only imports accounts whose email domain is in this
  list; every other account in the workspace (including all of the other tenant's) is
  skipped and only counted, never listed by address. `InstantlyProvider`
  also refuses to push a lead unless this is set.
- `INSTANTLY_CAMPAIGN_ID` - the firm's own campaign id(s) (comma list
  supported). The reply poll (`pollInstantlyReplies`) calls
  `GET /api/v2/emails` with `campaign_id` set per the docs
  (https://developer.instantly.ai/api-reference/email/list-email:
  "campaign_id - The ID of the campaign to filter emails by"), then
  re-checks each returned email's own `campaign_id` field client-side, and
  additionally drops anything whose mailbox (`eaccount`) is not in
  `INSTANTLY_ALLOWED_DOMAINS`. Anything that fails either check is skipped
  before it is ever stored or logged; only a count survives.
- If either var is unset, the reply poll refuses outright ("not
  configured") and touches nothing. Until the firm's own sending domains
  exist, `INSTANTLY_ALLOWED_DOMAINS` stays empty on purpose, so both the
  mailbox pull and the reply poll import zero rows.

**Recommendation:** once the firm is ready to send, give it its OWN Instantly
workspace rather than a sub-account of someone else's. Instantly API keys are scoped
per workspace, so a separate workspace isolates his mailboxes, replies, and
leads completely at the platform level -- no allowlist needed at all -- and
is also the cleaner posture for his firm's own compliance and books-and-
records obligations (nothing about his outreach lives inside an agency's
shared account). The env-var allowlist above is a stopgap for while both
tenants share one workspace, not a long-term architecture.

### Forwarding to the banker's normal inbox

Deal Desk does not and will not contain an email sender for replies. Instead,
on EACH Instantly sending mailbox, set a mailbox-level forwarding rule to the
banker's real firm inbox:

- Google Workspace: in the sending mailbox, Settings > Forwarding and POP/IMAP >
  Add a forwarding address (the admin may need to allow external forwarding
  under Apps > Google Workspace > Gmail > End User Access), keep Gmail's copy
  in the inbox. Or an admin routing rule in Apps > Gmail > Routing that adds
  the firm inbox as a recipient.
- Microsoft 365: Exchange admin center > Mail flow > Rules, "Bcc the message
  to" the firm inbox for mail sent to or from the sending mailbox, or
  Recipients > Mailboxes > the mailbox > Mail flow settings > Email forwarding
  with "Deliver message to both forwarding address and mailbox" on. Outbound
  spam policy must allow automatic forwarding.

Why: (1) there is exactly one path that sends email (Instantly, from approved
content) plus the banker's own inbox for personal replies; Deal Desk never
becomes a second, unsupervised send path. (2) The firm's email archive
(17a-4 retention, 3110 supervision) only captures what flows through the
firm's mail system; forwarding puts every prospect conversation there, in
addition to the append-only copy Deal Desk keeps.
