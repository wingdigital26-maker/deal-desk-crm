# Hosted deploy recipe: getting the banker signed in from his office

This is a recipe, not a deployment. Nothing in this document has been run
against a real host. It is written for a non-technical owner: follow the
steps in order, in a terminal, on any computer with internet access.

## Read this before anything else

**Do not load real client, buyer, or company data into a hosted copy of this
app until the firm's compliance and IT functions have signed off.** This app
will hold non-public information about the firm's clients and the deal
activity of real buyers, on a server outside the firm's own network, paid
for and administered by Jack rather than the firm's IT department. At a
FINRA-member broker-dealer that is not Jack's call to make alone. Before any
real data goes on a hosted copy, get a written yes from the firm's
compliance officer and IT, and keep it. Relevant standards to know the
names of before that conversation, not to interpret yourself:

- **FINRA Notice 21-29** (vendor management and outsourcing oversight):
  a firm that outsources a function, including hosting a system like this
  one, still owns the supervisory and compliance obligations for it, and is
  expected to have done due diligence on the vendor (here, whichever host is
  chosen) before going live.
- **FINRA Rule 3110** (supervision): the firm needs a documented supervisory
  procedure that covers this system, not just permission to use it.
- **Exchange Act Section 15(g)** (policies to prevent misuse of material
  non-public information): deal information in this app is exactly the kind
  of MNPI those policies exist for; access controls and who can see what
  need review, not just a password screen.
- **SEC Rule 17a-4** (records retention): if this app's audit log and
  message records count as books and records the firm must retain, the
  hosting and backup plan needs to meet that rule's retention and
  accessibility requirements, not just "we have backups."

Until that sign-off exists, use this recipe only with fictional or
throwaway data (see `scripts/test-hosted-local.mjs` for exactly that kind of
dry run) to prove the mechanics work.

See also the security checklist and the reasoning behind Option A in
[docs/DEPLOY.md](./DEPLOY.md).

## What you are choosing between

Both paths below run the exact same Docker image (`deploy/Dockerfile`) as a
single always-on server with one persistent disk for the database. Neither
requires any code change. Pick whichever pricing and dashboard you find
easier to use; Fly.io and Railway are both reasonable.

## Path A: Fly.io

1. Install the Fly CLI and sign in (`flyctl auth login`) using a Fly.io
   account. This is the one account-creation step in this whole recipe;
   Jack does this himself, not an agent.
2. Rename the app. Open `deploy/fly.toml` and change
   `app = "deal-desk-CHANGEME"` to something unique, for example
   `yourfirm-deal-desk`. Fly app names are global across every Fly
   customer, so the placeholder will not work as-is.
3. From the repo root, run `fly launch --config deploy/fly.toml --no-deploy`
   the first time to create the app shell and the volume without deploying
   yet, then attach a volume if one was not created automatically:
   `fly volumes create harness_data --region dfw --size 1` (1 GB is
   generous for a single firm's contacts and deals; grow it later if
   needed).
4. Set secrets, never in a file:
   - `openssl rand -hex 32` on any machine with OpenSSL, then
     `fly secrets set SESSION_SECRET=<that value>`.
   - Do not set `APOLLO_API_KEY` or `SEED_PASSWORD` unless and until
     outbound sending is actually being turned on for real, per
     `docs/ENV.md`.
5. Deploy: `fly deploy --config deploy/fly.toml`.
6. Create the first owner account. Fly machines are reachable with
   `fly ssh console`; from inside that console, run seed-user.mjs against
   the mounted volume, for example:
   ```
   SEED_PASSWORD="a real throwaway password, 12+ chars, change it after first login" \
     node scripts/seed-user.mjs --email owner@thefirm.example --name "Owner Name" --role owner
   ```
   Sign in at the app's `.fly.dev` URL with that email and password, then
   change the password from inside the app if it has a change-password
   screen, or reseed with a new value.
7. Custom domain and HTTPS: `fly certs add deal-desk.thefirm.example` (or
   whatever subdomain the firm's IT wants to use), then add the CNAME or A
   record Fly reports back to your DNS provider. Fly issues and renews the
   certificate automatically once DNS resolves; this usually takes a few
   minutes to a few hours depending on DNS propagation. `force_https = true`
   is already set in `deploy/fly.toml`, so plain http is refused.

## Path B: Railway

1. Sign in to Railway (railway.app) using a Railway account. Jack does this
   himself.
2. Create a new project from this GitHub repo (or `railway up` from the
   repo root with the Railway CLI). Railway will find `deploy/railway.json`
   and use the Dockerfile builder automatically.
3. Add a Volume to the service (Railway dashboard: Service -> Settings ->
   Volumes) and set its mount path to `/app/data`. This is the step that
   most needs double-checking: without it, the database is wiped on every
   redeploy exactly like on Fly.
4. Set variables (Service -> Variables), not committed to any file:
   - `SESSION_SECRET` = output of `openssl rand -hex 32`.
   - `NODE_ENV=production`, `HARNESS_DB_PATH=/app/data/harness.db`,
     `HARNESS_FILES_DIR=/app/data/files`, `OUTBOUND_SEND_ENABLED=0`,
     `GRAPH_CAPTURE_ENABLED=0`. Do not set `HARNESS_NO_LOGIN`.
5. Deploy. Railway builds the Dockerfile and starts the container; the
   healthcheck path is `/login`, matching Fly and the Dockerfile.
6. Create the first owner account. Use `railway run` to execute a one-off
   command against the deployed service with its real environment
   (including the mounted volume):
   ```
   railway run --service <service-name> \
     env SEED_PASSWORD="a real throwaway password, 12+ chars, change it after first login" \
     node scripts/seed-user.mjs --email owner@thefirm.example --name "Owner Name" --role owner
   ```
7. Custom domain and HTTPS: Service -> Settings -> Networking -> Custom
   Domain, then add the CNAME Railway reports to your DNS provider. Railway
   issues the certificate automatically once DNS resolves.

## Backups, on either host

`scripts/backup-db.mjs` writes a timestamped, consistent snapshot of the
live database (and, once a later package adds document uploads, a copy of
`HARNESS_FILES_DIR` too) into a `backups/` folder on the same volume, and
keeps the newest `BACKUP_KEEP` (default 14) automatically. Run it on a
schedule:

- **Fly**: a small scheduled Fly Machine (`fly machine run` with a cron-like
  scheduler, or an external scheduler that calls `fly ssh console -C
  "node scripts/backup-db.mjs"` nightly) is the simplest option today.
- **Railway**: Railway's cron/scheduled jobs feature (if available on the
  plan) running the same command, or an external scheduler hitting
  `railway run node scripts/backup-db.mjs`.

That backup still lives on the same box as the app. Get a copy off-box
regularly, without automating a cloud upload here:

- **Fly**: `fly sftp get backups/harness-<stamp>.db ./local-copy.db` run
  from Jack's own machine, on a schedule Jack remembers to run, or scripted
  from a second small machine Jack controls that has the Fly CLI installed.
- **Railway**: exec into the service with `railway run bash` (or the
  dashboard's shell) and copy the file out over SFTP/SCP to a machine Jack
  controls, or take a volume snapshot from the dashboard if the current
  plan offers one.

**Restore drill (do this once, before it matters for real):**

1. `node scripts/backup-db.mjs` to produce a fresh snapshot.
2. `node scripts/restore-db.mjs backups/harness-<stamp>.db --yes`. This
   takes a safety copy of whatever is live first, then restores the chosen
   snapshot over it, and warns (but does not refuse) if it looks like the
   app currently has the database open, since a plain script cannot know
   that for certain, only stop the app first if you can.
3. Confirm you can still sign in and that the owner account from the seed
   step above still exists.

## Cost

Roughly $5 to $25 a month total: a small always-on machine (Fly's cheapest
shared-CPU machine or Railway's equivalent hobby/starter tier) plus a small
persistent volume (1 GB is enough to start). Custom domain HTTPS is free on
both. This does not include Apollo or any outbound-sending cost, because
`OUTBOUND_SEND_ENABLED` stays `0` in this recipe.

## What this recipe deliberately does not do

- No account was created on Fly, Railway, or anywhere else while writing
  this recipe.
- No secrets exist anywhere in this repo; every secret above is set on the
  host at deploy time, not committed.
- No real client or buyer data is used anywhere in this recipe or its local
  test script; see the compliance gate at the top of this document.
