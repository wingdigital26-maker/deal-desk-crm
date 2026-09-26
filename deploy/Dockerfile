# Runs the banker harness as a single always-on container (Option A in
# docs/DEPLOY.md). Every line that matters is explained in deploy/README.md.
# Not built or run here; this is a recipe for the main session or Jack to use.

FROM node:24-slim AS build
WORKDIR /app

# Install dependencies first so this layer is cached when only app code changes.
COPY package.json package-lock.json* ./
RUN npm ci

# Now bring in the rest of the source and build the production bundle.
COPY . .
RUN npm run build

# ---- runtime stage: smaller image, no build tools left behind ----
FROM node:24-slim AS runtime
WORKDIR /app

# The Python lead-collector (scrapers/harness_signals.py) runs on this same
# box against the same SQLite file, so Python 3 has to be present here too.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Only copy what next start actually needs to run, not the whole build tree.
COPY --from=build /app/public ./public
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scrapers ./scrapers
COPY --from=build /app/firm.config.ts ./firm.config.ts

# Non-root user. The image ships a "node" user already; just own the app dir.
# /app/data/files is created ahead of time for a later package that stores
# uploaded deal documents there, so that package can rely on it existing on
# any host that follows this Dockerfile, whether or not it has shipped yet.
RUN mkdir -p /app/data/files \
  && chown -R node:node /app
USER node

# This is where HARNESS_DB_PATH and HARNESS_FILES_DIR should point. Mount a
# real volume here (see deploy/fly.toml) or both the database and any
# uploaded documents are lost on every redeploy.
VOLUME ["/app/data"]

ENV HARNESS_DB_PATH=/app/data/harness.db
ENV HARNESS_FILES_DIR=/app/data/files
ENV PORT=3000
EXPOSE 3000

# Confirms the app is actually answering, not just that the process exists.
# /login is public (see proxy.ts) so this succeeds even signed out.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) +'/login').then(r=>{if(r.ok)process.exit(0);process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
