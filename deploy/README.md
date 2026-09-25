# Deploy recipe (Option A): one always-on server with a persistent disk

This is a recipe, not a deployment. Nothing here has been built or run.
Read docs/DEPLOY.md first for why this is the recommended path right now.

## What is in this folder

- `Dockerfile`: builds the app into a container image.
- `fly.toml`: a working Fly.io app definition that uses that Dockerfile.
  The same Dockerfile works on Railway or Render with their own config
  formats, or on a plain VPS with `docker run` directly; fly.toml is one
  concrete example, not the only option.
- `postgres/`: the Postgres translation of the schema, for Option C later.
  Not used by Option A at all.

## Dockerfile, explained line by line where it matters

- `FROM node:24-slim AS build`: the app requires Node 24 (node:sqlite, the
  built-in synchronous SQLite driver the whole data layer depends on, is
  the reason). `-slim` keeps the image small while still having a normal
  Debian base for `npm ci` to work against.
- Two-stage build (`build` then `runtime`): the build stage needs the full
  dependency tree and dev tools to run `next build`; the runtime stage
  only needs the compiled output and production dependencies, which keeps
  the shipped image smaller and reduces what an attacker could find in it.
- `COPY package.json package-lock.json* ./` before `COPY . .`: Docker
  caches layers, so dependencies only get reinstalled when package.json
  actually changes, not on every source edit. Faster rebuilds.
- `apt-get install python3`: scrapers/harness_signals.py is the lead
  collector and it opens the same SQLite file directly. If it runs on this
  same box (recommended, since it needs to reach the same data/harness.db
  as the app), Python 3 has to be present in the runtime image.
- `COPY --from=build ...` (public, .next, node_modules, package.json,
  scrapers, firm.config.ts): only the files `next start` and the Python
  collector actually need at runtime. Test files, source .ts files already
  compiled into .next, and dev tooling are left out of the final image.
- `RUN mkdir -p /app/data && chown -R node:node /app` then `USER node`:
  the container does not run as root. `node:24-slim` already ships a
  built-in `node` user; this just makes sure it owns the app directory,
  including the future mount point for the data volume.
- `VOLUME ["/app/data"]`: documents that this path must be backed by
  persistent storage. On Fly this is the `[[mounts]]` block in fly.toml;
  on a plain VPS running Docker directly this is a `-v` flag
  (`-v harness_data:/app/data`) or a bind mount to a real directory on the
  host disk.
- `ENV HARNESS_DB_PATH=/app/data/harness.db`: points the app's database
  path (see docs/ENV.md) at the mounted volume, so the file survives
  container restarts and redeploys instead of living in the throwaway
  container filesystem.
- `HEALTHCHECK ... CMD node -e "fetch(...)"`: hits `/login`, which is
  public per proxy.ts, so the check passes whether or not anyone is
  signed in. It only tells the host "the app is answering HTTP requests",
  which is what a healthcheck should confirm; it does not touch the
  database or require credentials.
- `CMD ["npm", "run", "start"]`: runs `next start` per package.json,
  serving the already-built app from the build stage.

## fly.toml, explained where it matters

- `app = "banker-harness"`: Fly app names are global across all Fly users;
  this will need to be renamed to something unique before it can actually
  be created (for example `your-firm-deal-desk`).
- `[build] dockerfile = "deploy/Dockerfile"`: tells `fly deploy` to build
  from this Dockerfile instead of looking for one at the repo root.
- `[env]`: only non-secret values go here, because fly.toml is a plain
  text file that can end up committed to source control. Real secrets
  (SESSION_SECRET, APOLLO_API_KEY if outbound sending is ever turned on,
  SEED_PASSWORD if seeding is ever run against production) must be set
  with `fly secrets set NAME=value`, which stores them encrypted and never
  writes them to a file in the repo.
- `[[mounts]]`: this is what actually gives the container a persistent
  disk. Without it, `/app/data` (and the SQLite file inside it) would be
  wiped clean on every single deploy, because container filesystems are
  otherwise thrown away and rebuilt fresh from the image each time.
- `[http_service] force_https = true`: Fly terminates TLS at its edge and
  this setting refuses plain http, satisfying the "HTTPS only" line in the
  docs/DEPLOY.md security checklist without any certificate setup.
- `min_machines_running = 1`, `auto_stop_machines = false`: keeps exactly
  one instance running all the time. This matters because SQLite only
  supports one writer process safely; this app must never be scaled to
  more than one running machine while it still uses SQLite.
- `[[http_service.checks]]`: Fly's own load balancer check, separate from
  but matching the Dockerfile's HEALTHCHECK, so Fly also knows not to
  route traffic to a machine that is not actually answering.

## What is deliberately not done here

- No `docker build` or `docker run` was executed. These files are written
  and reviewed, not tested, per the lane restriction for this pass.
- No secrets are set anywhere in this folder. Every secret referenced
  above must be created and set by whoever actually deploys this, using
  `fly secrets set` or the equivalent for the chosen host. See docs/ENV.md
  for the full list and what each one does.
- No account was created on Fly, Railway, Render, or any VPS provider.
  That step, and the decision of which one to use, is Jack's to make; this
  folder just makes that step a copy-and-deploy action instead of a
  from-scratch setup.
- Off-box backups are not automated here. A simple, safe pattern once
  this is live: a small nightly script (or a Fly Machines scheduled run)
  that copies `/app/data/harness.db` to encrypted off-site storage (for
  example an S3-compatible bucket with server-side encryption). That
  script is a follow-up task, not part of this recipe, and should not
  touch the live database file while the app is writing to it (SQLite's
  WAL mode, already enabled in app/lib/db.ts, makes a plain file copy of
  the main db file safe to take while the app keeps running, but a proper
  `sqlite3 .backup` style snapshot is the more careful option if this
  becomes a recurring, unattended job).
