# Environment variables

Every environment variable the app or its scripts read, found by searching
process.env across app/, scripts/, and proxy.ts. None of these are set in
the repo; they must be set on whatever machine or host runs the app.

## SESSION_SECRET

- What it does: signs and verifies the login session cookie (jose JWT,
  HS256). Read in app/lib/session.ts and proxy.ts.
- Secret: yes. Treat it like a password. Never commit it, never log it,
  never paste it into chat or a ticket.
- Safe example: a random 64-character hex string, for example generate one
  with `openssl rand -hex 32` on any machine with OpenSSL. Do not use a
  short or guessable value; the app requires at least 32 characters.
- If missing: the app fails closed. app/lib/session.ts returns no secret,
  so no session can be signed or verified. proxy.ts then treats every
  request as signed out and redirects to /login. Nobody can log in until
  this is set. This is intentional, not a bug.

## HARNESS_DB_PATH

- What it does: the file path to the SQLite database. Read in
  app/lib/db.ts and scripts/seed-user.mjs.
- Secret: no, but the file it points to contains real contact and deal
  data, so protect the file itself with normal file permissions and
  backups.
- Safe example: `/app/data/harness.db` (inside the Docker container; see
  deploy/Dockerfile) or `data/harness.db` for local development.
- If missing: defaults to `data/harness.db` under the app's working
  directory. That default is fine as long as data/ is the mounted,
  persistent volume in production; see docs/DEPLOY.md Option A.

## OUTBOUND_SEND_ENABLED

- What it does: the final gate before any outbound email actually sends.
  Read in app/lib/outbound/sendGate.ts, app/api/outbound/messages/due/route.ts,
  and the outbound pages that show whether sending is armed.
- Secret: no.
- Safe example: unset, or `0`, in every environment except a fully
  reviewed production go-live. Set to `1` only when real sending should be
  possible.
- If missing (or anything other than the exact string `1`): the send gate
  fails closed and refuses to send. This is the primary safety switch for
  compliant outbound; do not set it to `1` casually.

## OUTBOUND_PROVIDER

- What it does: selects which outbound sending provider the app talks to.
  Read in app/lib/outbound/provider.ts. Currently checks for the value
  `apollo`.
- Secret: no.
- Safe example: `apollo`, or unset to use whatever the app's default
  provider path is.
- If missing: the app does not select the Apollo provider branch; check
  app/lib/outbound/provider.ts for the fallback behavior before relying on
  a specific default.

## APOLLO_API_KEY

- What it does: authenticates outbound calls to the Apollo API. Read in
  app/lib/apollo/client.ts.
- Secret: yes. This is a real API credential; never commit it, never log
  it, never echo it back to a client or into a UI.
- Safe example: not applicable, this must be the real key issued by
  Apollo. No key is configured in this dev worktree and none should be
  added here.
- If missing: app/lib/apollo/client.ts reports itself as not configured
  (see the boolean check at line 44) and calls that need it should not be
  made. No Apollo calls should ever fire without this key present and
  intentionally set.

## HARNESS_DEMO

- What it does: toggles a demo banner/mode in the app shell. Read in
  app/layout.tsx.
- Secret: no.
- Safe example: `1` for a demo environment shown to a prospective client,
  unset for the real, live workspace.
- If missing: demo mode is off, which is the correct default for the real
  banker's workspace.

## HARNESS_DEMO_DB_PATH

- What it does: the SQLite file path used by the demo seed script only.
  Read in scripts/seed-demo.mjs.
- Secret: no.
- Safe example: `data/demo.db`.
- If missing: defaults to `data/demo.db`, kept separate from the real
  `data/harness.db` on purpose so demo seeding never touches real data.

## SEED_PASSWORD

- What it does: sets the password for demo or seed users created by
  scripts/seed-demo.mjs and scripts/seed-user.mjs.
- Secret: yes, in the sense that any password is. It is only used for
  local seeding and demo accounts, never for the real banker's own
  account, which he should set himself.
- Safe example: a throwaway password used only in a local or demo
  environment, at least 12 characters.
- If missing: scripts/seed-demo.mjs falls back to a hardcoded demo
  password (`demo-workspace-member-pw`) for the demo member account,
  which is fine for a disposable demo database and never acceptable for a
  real production account. scripts/seed-user.mjs requires it and will not
  create a real user without it.

## NODE_ENV

- What it does: standard Node/Next.js environment flag. Read directly in
  app/api/auth/login/route.ts to decide whether the session cookie gets
  the Secure attribute.
- Secret: no.
- Safe example: `production` in any real deployment. Next.js sets this
  automatically for `next build` and `next start`.
- If missing or not `production`: the login cookie is issued without the
  Secure attribute, which is only acceptable for local development over
  plain http. Never run a real deployment with NODE_ENV unset.
