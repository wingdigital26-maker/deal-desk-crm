# Deal Desk

**Live demo: [dealdesk-demo.vercel.app](https://dealdesk-demo.vercel.app)**
(no sign-in; every company, person and message is fictional sample data, and sending is disabled)

A CRM plus a compliance-gated outbound harness for M&A bankers.

Deal Desk keeps a banker's companies, contacts, deals and tasks in one place, and it
lets the desk run outbound email without ever sending content a registered principal
has not approved. It is built for a regulated firm (FINRA Rule 2210 style review):
every outbound template is approved by a compliance principal, the approval is bound
to a hash of the exact content, and the send path re-checks everything at send time
and fails closed.

## Demo mode

Set `DEAL_DESK_DEMO=1` to run the app as a public, read-mostly sample workspace (this is
how the live demo is hosted on Vercel). `npm run build` then seeds `demo/demo.db` from
`scripts/seed-demo.mjs`, and at runtime the app copies it to the temp dir and works on
that copy, so visitor edits reset when the instance recycles. In demo mode:

- sign-in is skipped and every visitor acts as the demo owner
- every send provider is forced to dry run, whatever else the environment says
- Apollo, Instantly, reply sync, profile refresh (Python), password changes and user
  management routes return "Not available in the demo"
- no secrets are needed or used; `DEAL_DESK_DEMO=1` is the only variable

## Features

**CRM**
- Companies, contacts and a per-record activity timeline
- Deal pipeline board with configurable stages, deal detail and tasks
- Today view: open deals, deals going quiet, replies to handle, new signals
- CSV import with formula neutralisation
- Company and owner profiles where every field carries its public source

**Compliance-gated outbound**
- Templates with a voice/compliance check (forbidden phrases, no fee talk, no promises)
- Principal approval bound to a SHA-256 content hash; any edit voids approval
- The submitter of a template cannot approve it
- Only allow-listed personalisation fields are merged into approved content
- Legal footer (postal address + one-click opt-out) is part of the approved content
- Warm-up ramp per mailbox, daily caps, do-not-contact list, never re-emails a replier
- Send gate re-checks hash, approval, suppression, do-not-contact, lint, mailbox cap and
  the global send switch before anything leaves
- Append-only audit log of every state change
- Reply, bounce and unsubscribe sync (Apollo or Instantly)

**Sourcing**
- Stdlib-only Python scrapers: a state franchise-tax registry pull, domain resolution,
  on-site email harvesting with pattern inference, MX checks, and public signals
  (hiring boards, news, federal awards). See `docs/SOURCING.md` and `scrapers/README.md`.
- Optional Apollo search and enrichment behind an owner-only daily credit cap

**Access**
- Roles: owner, principal, member. Rate-limited sign-in, change password, people admin.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS 4
- SQLite via Node's built-in `node:sqlite` (Node 22+); a Postgres schema is in `deploy/postgres/`
- `jose` for session tokens
- Vitest for tests
- Python 3 (standard library only) for the scrapers

## Quickstart

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env.local          # fill in SESSION_SECRET (32+ random characters)

# Create your first login (password comes from the environment, never a flag)
SEED_PASSWORD="at least 12 chars" node scripts/seed-user.mjs --email owner@yourfirm.example --name "Your Name" --role owner

npm run dev                          # http://localhost:3000
```

### Demo workspace

To look around with realistic, fully fictional data:

```bash
SEED_PASSWORD="at least 12 chars" npm run seed:demo   # writes data/demo.db
npm run dev:demo                                      # runs the app against data/demo.db
```

Sign in as `owner@harness.local` (or `principal@harness.local`) with the password you set.

### Tests

```bash
npx vitest run
npx tsc --noEmit
```

## Sending is off by default

Nothing is sent unless **all** of these are true: `OUTBOUND_SEND_ENABLED=1`, a provider
is configured (`OUTBOUND_PROVIDER` plus its keys), the exact content has a principal
approval, and the recipient passes every gate. With any of them missing the app runs a
dry run and shows why each message was blocked. See `docs/ENV.md` and
`app/lib/outbound/README.md`.

## Make it yours

The firm is set in one file: `firm.config.ts`. Change the firm name, sender, postal
address, deal stages, target segments, outbound footer, warm-up ramp and voice rules
there. No other file names a firm.

Deployment notes are in `docs/DEPLOY.md` and `deploy/`.

## Licence

All rights reserved. No licence is granted to use, copy, modify or distribute this code
without written permission.

Built by Wing Digital.
