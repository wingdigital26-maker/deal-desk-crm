# Deploy recipe (Option A): one always-on server with a persistent disk

This is a recipe, not a deployment. Nothing here has been built or run.
Read docs/DEPLOY.md first for why this is the recommended path right now.

## What is in this folder

- `Dockerfile`: builds the app into a container image.
- `fly.toml`: a working Fly.io app definition that uses that Dockerfile.
  Rename the placeholder app name (`deal-desk-CHANGEME`) before use; Fly app
  names are global.
- `railway.json`: the Railway equivalent, using the same Dockerfile with
  Railway's builder config format. Railway volumes are created in its
  dashboard, not in this file; see the `_notes` block inside it and
  `docs/HOSTED-DEPLOY.md`.
- The same Dockerfile also works on Render with its own config format, or on
  a plain VPS with `docker run` directly; fly.toml and railway.json are two
  concrete examples, not the only options.
- `postgres/`: the Postgres translation of the schema, for Option C later.
  Not used by Option A at all.
- The full, step-by-step version of "how do I actually get this live" for a
  non-technical owner is `docs/HOSTED-DEPLOY.md`, not this file. This file
  stays focused on explaining the Dockerfile and fly.toml line by line.

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
- `ENV HARNESS_DB_PATH=/app/data/harness.db` and
  `ENV HARNESS_FILES_DIR=/app/data/files`: point the app's database path
  (see docs/ENV.md) and the directory a later package will use for uploaded
  deal documents at the same mounted volume, so both survive container
  restarts and redeploys instead of living in the throwaway container
  filesystem. `HARNESS_FILES_DIR` is not read by any code yet; the
  directory and env var exist ahead of time so that package does not need a
  deploy-recipe change when it ships.
- `HEALTHCHECK ... CMD node -e "fetch(...)"`: hits `/login`, which is
  public per proxy.ts, so the check passes whether or not anyone is
  signed in. It only tells the host "the app is answering HTTP requests",
  which is what a healthcheck should confirm; it does not touch the
  database or require credentials.
- `CMD ["npm", "run", "start"]`: runs `next start` per package.json,
  serving the already-built app from the build stage.

## fly.toml, explained where it matters

- `app = "deal-desk-CHANGEME"`: Fly app names are global across all Fly
  users; this placeholder must be renamed to something unique before it can
  actually be created (for example `yourfirm-deal-desk`).
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

- No `docker build` or `docker run` was executed; Docker is not installed on
  the machine that wrote this recipe. `scripts/test-hosted-local.mjs`
  exercises the same startup contract (production build, login gate, seed
  script, backup/restore) without Docker, and its output is reported
  alongside this recipe. That is not the same as a real `docker build`, and
  a real one should still be run before this ever goes live.
- No secrets are set anywhere in this folder. Every secret referenced
  above must be created and set by whoever actually deploys this, using
  `fly secrets set`, Railway service variables, or the equivalent for the
  chosen host. See docs/ENV.md for the full list and what each one does.
- No account was created on Fly, Railway, Render, or any VPS provider.
  That step, and the decision of which one to use, is Jack's to make; this
  folder just makes that step a copy-and-deploy action instead of a
  from-scratch setup.
- Off-box backups are not automated here (no cloud upload code exists in
  this repo). `scripts/backup-db.mjs` produces the on-box snapshot using
  node:sqlite's own backup API when available, or `VACUUM INTO` otherwise,
  either of which is safe to run while the app keeps writing to the
  database under WAL. `docs/HOSTED-DEPLOY.md` documents the manual
  `fly sftp get` / Railway volume-copy step to get a copy off the box,
  without implementing any cloud upload. That copy-off-box step is a
  follow-up task, not part of this recipe.
