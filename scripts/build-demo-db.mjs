#!/usr/bin/env node
// Builds demo/demo.db, the fictional workspace bundled with the hosted demo
// (DEAL_DESK_DEMO=1, see app/lib/demo.ts). Runs as part of `npm run build`,
// but only does anything when DEAL_DESK_DEMO=1 or --force is passed, so a
// normal production build is untouched.
//
// The demo login users get a random throwaway password: nobody signs in to the
// demo (demo mode skips sign-in), so the hash is never usable.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "demo", "demo.db");

if (process.env.DEAL_DESK_DEMO !== "1" && !process.argv.includes("--force")) {
  console.log("build-demo-db: DEAL_DESK_DEMO is not 1, skipping.");
  process.exit(0);
}

const seed = spawnSync(process.execPath, [path.join(ROOT, "scripts", "seed-demo.mjs")], {
  stdio: "inherit",
  cwd: ROOT,
  env: { ...process.env, HARNESS_DEMO_DB_PATH: OUT, SEED_PASSWORD: randomBytes(24).toString("hex") },
});
if (seed.status !== 0) process.exit(seed.status ?? 1);

// One self-contained file (no -wal/-shm sidecars) so it copies cleanly at runtime.
const db = new DatabaseSync(OUT);
db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;");
db.close();
for (const s of ["-wal", "-shm"]) if (existsSync(OUT + s)) rmSync(OUT + s);
console.log(`build-demo-db: wrote ${OUT}`);
