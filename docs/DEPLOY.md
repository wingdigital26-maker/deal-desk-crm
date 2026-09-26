# Deploy decision: how the banker signs in from his office

This is written for a non-technical owner. No code required to read this.
It compares the real hosting options for this exact app and recommends a path.

For the actual step-by-step recipe once Option A below is the chosen path,
see [docs/HOSTED-DEPLOY.md](./HOSTED-DEPLOY.md), including the compliance
gate at its top: do not load real client or buyer data until the firm's
compliance and IT sign off.

## The one fact that decides this

The app stores all data (contacts, deals, templates, audit log, everything)
in a single file on disk, using SQLite, read and written synchronously.
That code is spread across 48 files and 173 separate places in the app.
Rewriting it is not a small change. It decides which hosting options are
realistic today and which ones need real engineering time first.

## Option A: one small always-on server with a persistent disk

Examples: Fly.io, Railway, Render (with a paid disk add-on), or a plain VPS
(DigitalOcean, Linode). What they have in common: the app runs all the time
on one machine, and that machine has a hard drive that keeps its files
between restarts.

- Code changes needed: none. The app runs exactly as it does on the dev
  machine right now.
- The Python lead-collector script (scrapers/harness_signals.py) keeps
  working, because it also just opens the same SQLite file.
- Backups: a nightly copy of the database file to somewhere else (see
  below). Simple, well understood, no new moving parts.
- The catch: only one copy of the app can run at a time. That is fine for
  one bank, one office, normal traffic. It would not survive being resold
  to ten banks on one shared instance.
- Monthly cost: roughly 5 to 25 dollars a month for a small VPS or a
  Fly.io/Railway app with a small volume attached. Cheap.
- Effort to get live: a few hours, mostly account setup and DNS, using the
  Dockerfile in deploy/ already written for this.
- What is needed exactly:
  - Node 24 (the app requires it; see deploy/Dockerfile)
  - Environment variables set on the host (full list and meaning in
    docs/ENV.md): SESSION_SECRET, HARNESS_DB_PATH, OUTBOUND_SEND_ENABLED,
    OUTBOUND_PROVIDER, APOLLO_API_KEY if outbound sending is turned on later
  - A volume (persistent disk) mounted at data/ inside the container, so the
    database file survives deploys and restarts
  - HTTPS on the public URL (Fly.io, Railway and Render all give you this
    for free with no extra setup; a plain VPS needs Caddy or nginx with
    Let's Encrypt, roughly 20 minutes of setup)
  - A nightly job that copies data/harness.db off the box to somewhere else
    (see the security checklist below)

**This is the fastest real path to the banker signing in from his office
this month.**

## Option B: Vercel or any other serverless host

Not compatible with this app as it stands, and this is not a small gap.
Serverless platforms do not give you a persistent disk, and they can run
many copies of your app at once to handle traffic, sometimes on different
physical machines within the same minute. A SQLite file written by one
copy would not be seen by another copy, and could be wiped entirely on
every deploy. To run on Vercel, the data layer would have to be replaced
with a real network database (see Option C). There is no cheap workaround
that keeps SQLite and runs on Vercel.

## Option C: hosted Postgres (Supabase or Neon)

This is the right long-term answer, especially if this app is ever resold
to a second or third bank. With Postgres:

- Each bank can get its own database (or its own walled-off section of one
  database), so one bank's data is never visible to another bank's users
  even if there is a bug somewhere. That is the standard way to sell one
  piece of software to many separate regulated clients.
- Managed backups, point-in-time recovery, and encryption at rest come
  from the hosting provider instead of a script Jack has to babysit.
- The app can run on Vercel, Fly, or anywhere else, and can scale to more
  than one copy running at once.

**The honest cost:** every single database call in this app today is
synchronous (`db().prepare(...).all()/get()/run()`), because node:sqlite is
a synchronous API. There are 173 of those calls across 48 files. Postgres
drivers are asynchronous. That means:

- Every one of those 173 call sites needs to change from a plain function
  call into an `await`, and every function that calls `db()` needs to
  become an `async` function, all the way up to the API route or server
  component that started the chain.
- This is not conceptually hard, but it touches nearly every file in the
  app, including files owned by different work lanes. It is realistically
  a multi-day change, not an afternoon change, done deliberately and
  tested carefully rather than rushed.

**What a thin async data-access layer looks like:** instead of rewriting
every call site by hand, wrap the database behind a small set of async
functions (getContact, listDeals, insertActivity, and so on) that internally
call the Postgres driver. Each of the 48 files gets updated to call these
async functions and to `await` them, but the SQL and the shape of the data
stay close to what they are today, because deploy/postgres/schema.sql is a
faithful translation of the current schema. That keeps the rewrite
mechanical (find every db() call, replace with the matching async
function) rather than a redesign.

**Migration order, if this is done:**

1. Stand up the Postgres database from deploy/postgres/schema.sql on
   Supabase or Neon. Do this with zero live users, so there is time to
   test.
2. Write the thin async data-access layer described above, one table's
   worth of functions at a time (users, then companies, then contacts,
   and so on), and update the call sites for that table before moving to
   the next.
3. Write a one-time export script that reads every row out of the current
   SQLite file and inserts it into Postgres, then run it against a copy of
   the real database, not the live file.
4. Run the app against Postgres locally with the migrated copy of the
   data, click through every page and every API route, and only then
   switch the production environment variable over.
5. Keep the SQLite file as a cold backup for a while after the cutover, in
   case something was missed.

## Recommendation

Do Option A now, so the banker can sign in from his office this month with
zero code rewrite and the Python collector still works unchanged. Plan
Option C as the resale architecture, once there is time to do the
multi-day rewrite properly and once there is an actual second bank lined
up to justify it. Do not attempt Option B; it does not fit this app's data
layer at all.

## Security checklist before this goes live at a regulated firm

This app touches non-public information about real companies and real
people the banker is talking to. Before it is reachable outside Jack's own
machine, all of the following should be true:

- HTTPS only. No plain http endpoint should ever be reachable; redirect
  http to https or disable it entirely at the host.
- Secure cookies. The session cookie must be marked Secure (already the
  case in production per app/api/auth/login/route.ts) so it is never sent
  over plain http.
- A long, random SESSION_SECRET (32+ characters, generated once, never
  reused from a demo or test value, never committed to any file that gets
  shared or logged). See docs/ENV.md.
- Every real user (the owner and any principal or member) has their own
  account with their own password. No shared logins, ever, because the
  audit log and the compliance approval model both depend on knowing
  exactly which person did what.
- An IP allow-list, or a real single sign-on (SSO) provider, as the next
  step after passwords. Passwords alone are an acceptable starting point,
  not a permanent state, for a system holding deal information at a
  regulated firm.
- Database encryption at rest. A VPS disk or a Fly.io/Railway volume can be
  encrypted at the platform level; check the box when creating it.
- Off-site, encrypted backups of the database file, stored somewhere other
  than the same box the app runs on, so a lost or compromised server does
  not also mean lost data.
- A retention policy for the audit log (audit_log in the database is
  already append-only by design; retention just means deciding how long to
  keep it and where, not deleting it casually).
- **Firm sign-off.** This system will hold information about the firm's
  clients and deal activity outside the firm's own network, on
  infrastructure Jack chooses and pays for. At a FINRA-member firm, that
  is a decision for the firm's own IT and compliance function, not
  something Jack should decide unilaterally by picking a host and putting
  it live. Before any real client-adjacent data goes on a server outside
  the firm's network, the firm's IT or compliance officer needs to review
  and approve where it is hosted and how it is secured. Jack should not
  host this himself without that sign-off, even if the technical setup
  above is done correctly.
