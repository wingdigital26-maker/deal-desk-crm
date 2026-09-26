#!/usr/bin/env node
// Exercises the container contract (deploy/Dockerfile's CMD) against an
// EXISTING, already-built checkout of this app, without Docker. Only
// fictional data is used: no real client, buyer, or company names.
//
// This script never builds in place and never touches the target
// checkout's node_modules or .next directory itself. It expects the
// checkout passed with --app-dir to already have a production build
// (`npm run build` already run there), unless --build is also passed, in
// which case it runs `npm run build` in that checkout for you.
//
// What this proves, end to end, the way the container would run it:
//   1. `next start` answers on a real port with NODE_ENV=production.
//   2. Login is ON: /login is reachable signed out, / redirects to /login.
//   3. scripts/seed-user.mjs (from the target checkout) creates a real
//      owner account.
//   4. POST /api/auth/login with that account's credentials succeeds and
//      sets the session cookie.
//   5. scripts/backup-db.mjs (from the target checkout) produces a
//      restorable snapshot.
//   6. scripts/restore-db.mjs (from the target checkout) restores it, and
//      the restored database still has the seeded user row.
//
// Usage:
//   node scripts/test-hosted-local.mjs --app-dir <path-to-existing-checkout> [--build]
//
//   --app-dir <path>  REQUIRED. An existing checkout of this repo that has
//                      its own node_modules already installed. There is no
//                      default; you must name the checkout explicitly. This
//                      script never installs, builds in place, or cleans
//                      node_modules/.next for you unless --build is passed.
//   --build            Run `npm run build` in --app-dir before starting the
//                       server. Omit this on a checkout that is already
//                       built; the script will fail fast with a clear
//                       message if --app-dir has no .next directory and
//                       --build was not passed.
//
// All temp state (the SQLite file, uploaded-files directory, and backups
// directory used for this run) lives in a fresh directory this script
// creates under the OS temp directory, and every deletion this script
// performs is guarded to only ever touch a path under that directory.
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

const appDirArg = argValue("--app-dir");
const shouldBuild = args.includes("--build");

if (!appDirArg) {
  console.error("Usage: node scripts/test-hosted-local.mjs --app-dir <path-to-existing-checkout> [--build]");
  console.error("");
  console.error("--app-dir is required and has no default. Point it at an existing checkout");
  console.error("of this repo with its own node_modules already installed. This script never");
  console.error("builds in place or touches node_modules/.next unless --build is passed.");
  process.exit(1);
}

const APP_DIR = path.resolve(appDirArg);
if (!existsSync(APP_DIR) || !existsSync(path.join(APP_DIR, "package.json"))) {
  console.error(`--app-dir does not look like a checkout of this app (no package.json found): ${APP_DIR}`);
  process.exit(1);
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? `: ${detail}` : ""}`);
}

function fail(name, detail) {
  record(name, false, detail);
}

// ---- fictional test identity, never real firm data ----
const TEST_EMAIL = "owner@fictional-test-firm.example";
const TEST_NAME = "Fictional Test Owner";
const TEST_PASSWORD = "correct-horse-battery-staple-test"; // 12+ chars, throwaway, this DB is deleted at the end

// A dedicated temp root for this run. Every deletion in this script is
// guarded to only ever operate on a path under this directory (see
// assertUnderTmpRoot below), specifically so a bug here can never reach
// outside a directory this script itself created and owns.
const TMP_ROOT = mkdtempSync(path.join(tmpdir(), "banker-harness-hosted-test-"));
const TMP_ROOT_RESOLVED = path.resolve(TMP_ROOT) + path.sep;
const DB_PATH = path.join(TMP_ROOT, "harness.db");
const FILES_DIR = path.join(TMP_ROOT, "files");
const BACKUP_DIR = path.join(TMP_ROOT, "backups");
const SESSION_SECRET = randomBytes(32).toString("hex");
const PORT = 4650 + (process.pid % 200); // spread out to reduce collisions across runs

// Refuses to delete anything that is not under TMP_ROOT. This is the one
// guard standing between a typo in this file and deleting something real;
// every rmSync call in this script goes through it.
function assertUnderTmpRoot(p) {
  const resolved = path.resolve(p);
  if (resolved !== TMP_ROOT_RESOLVED.slice(0, -1) && !resolved.startsWith(TMP_ROOT_RESOLVED)) {
    throw new Error(
      `Refusing to delete "${resolved}": it is not under this run's temp directory (${TMP_ROOT}). ` +
        "This script only ever deletes paths it created itself under the OS temp directory."
    );
  }
}

function safeRemove(p) {
  assertUnderTmpRoot(p);
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const BASE_ENV = {
  ...process.env,
  NODE_ENV: "production",
  HARNESS_DB_PATH: DB_PATH,
  HARNESS_FILES_DIR: FILES_DIR,
  SESSION_SECRET,
  PORT: String(PORT),
  // Explicitly unset so a leftover shell export can never sneak login off
  // during this test, matching "login is hard-off, never on" in production.
  HARNESS_NO_LOGIN: "",
};

function runSync(cmd, cmdArgs, extraEnv = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd: APP_DIR,
    env: { ...BASE_ENV, ...extraEnv },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return res;
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status === 200) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// Only stops the server process. Does NOT remove TMP_ROOT: the database file
// in there is still needed for the backup/restore checks that run after the
// server is stopped. TMP_ROOT is removed once, at the very end (or on an
// early failure exit), via safeRemove.
function killServer(child) {
  try {
    if (child && !child.killed) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      } else {
        child.kill("SIGTERM");
      }
    }
  } catch {
    // best effort
  }
}

async function main() {
  console.log(`App dir (existing checkout): ${APP_DIR}`);
  console.log(`Temp working dir: ${TMP_ROOT}`);
  console.log(`DB path: ${DB_PATH}`);
  console.log(`Files dir: ${FILES_DIR}`);
  console.log(`Port: ${PORT}`);
  console.log("");

  // 1. Build, only if explicitly requested. Otherwise require a prior build
  // already exists in --app-dir; this script never builds in place unless
  // asked to, and never cleans node_modules or .next in --app-dir.
  const hasBuild = existsSync(path.join(APP_DIR, ".next"));
  if (shouldBuild) {
    console.log("Running `npm run build` in --app-dir (production build; can take a few minutes)...");
    const build = runSync("npm", ["run", "build"]);
    if (build.status === 0) {
      record("next build", true);
    } else {
      fail("next build", `exit ${build.status}`);
      console.log(build.stdout?.slice(-4000));
      console.log(build.stderr?.slice(-4000));
      safeRemove(TMP_ROOT);
      printSummaryAndExit();
      return;
    }
  } else if (hasBuild) {
    record("next build", true, "skipped (--build not passed; using existing .next in --app-dir)");
  } else {
    fail(
      "next build",
      `no .next directory in ${APP_DIR} and --build was not passed. Run \`npm run build\` in ${APP_DIR} first, or re-run with --build.`
    );
    safeRemove(TMP_ROOT);
    printSummaryAndExit();
    return;
  }

  // 2. Seed the owner, using the seed script from the checkout under test.
  console.log("Seeding owner account (fictional test data)...");
  const seed = runSync("node", ["scripts/seed-user.mjs", "--email", TEST_EMAIL, "--name", TEST_NAME, "--role", "owner"], {
    SEED_PASSWORD: TEST_PASSWORD,
  });
  if (seed.status === 0) {
    record("seed-user.mjs creates owner", true);
  } else {
    fail("seed-user.mjs creates owner", seed.stderr?.trim() || `exit ${seed.status}`);
    safeRemove(TMP_ROOT);
    printSummaryAndExit();
    return;
  }

  // 3. Start the server the same way the Dockerfile's CMD does (npm run start),
  // in production mode, against the temp database.
  console.log("Starting `next start`...");
  const server = spawn("npm", ["run", "start", "--", "-p", String(PORT)], {
    cwd: APP_DIR,
    env: BASE_ENV,
    shell: process.platform === "win32",
  });
  let serverOutput = "";
  server.stdout?.on("data", (d) => (serverOutput += d.toString()));
  server.stderr?.on("data", (d) => (serverOutput += d.toString()));

  const base = `http://127.0.0.1:${PORT}`;
  const up = await waitForServer(`${base}/login`, 45_000);
  if (!up) {
    fail("next start comes up", `server did not answer within 45s. Output:\n${serverOutput.slice(-4000)}`);
    killServer(server);
    safeRemove(TMP_ROOT);
    printSummaryAndExit();
    return;
  }
  record("next start comes up", true, `listening on ${base}`);

  try {
    // 4. GET /login is 200 (public per proxy.ts, even signed out).
    const loginRes = await fetch(`${base}/login`, { redirect: "manual" });
    record("GET /login is 200", loginRes.status === 200, `got ${loginRes.status}`);

    // 5. GET / redirects to /login (login is ON, not bypassed).
    const rootRes = await fetch(`${base}/`, { redirect: "manual" });
    const location = rootRes.headers.get("location") || "";
    const redirectsToLogin = [301, 302, 307, 308].includes(rootRes.status) && location.includes("/login");
    record("GET / redirects to /login (login is ON)", redirectsToLogin, `status ${rootRes.status}, location ${location}`);

    // 6. POST /api/auth/login with the seeded credentials succeeds and sets a cookie.
    const loginPost = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
      redirect: "manual",
    });
    const setCookie = loginPost.headers.get("set-cookie") || "";
    const loginOk = loginPost.status === 200 && setCookie.includes("harness_session=");
    record("POST /api/auth/login succeeds and sets cookie", loginOk, `status ${loginPost.status}, set-cookie present: ${setCookie.includes("harness_session=")}`);
  } finally {
    killServer(server);
  }

  // 7. Backup the temp database, using the backup script from the checkout under test.
  console.log("Running scripts/backup-db.mjs...");
  const backup = runSync("node", ["scripts/backup-db.mjs"], { BACKUP_DIR });
  const backupFiles = existsSync(BACKUP_DIR)
    ? readdirSync(BACKUP_DIR).filter((f) => /^harness-\d{8}-\d{4}\.db$/.test(f))
    : [];
  const backupOk = backup.status === 0 && backupFiles.length > 0;
  record("backup-db.mjs produces a snapshot", backupOk, backupOk ? backupFiles[0] : backup.stderr?.trim());

  if (backupOk) {
    // 8. Restore it back over the (now stopped) database and verify the user row survives.
    console.log("Running scripts/restore-db.mjs...");
    const backupPath = path.join(BACKUP_DIR, backupFiles[0]);
    const restore = runSync("node", ["scripts/restore-db.mjs", backupPath, "--yes"], { BACKUP_DIR });
    record("restore-db.mjs restores the snapshot", restore.status === 0, restore.status === 0 ? undefined : restore.stderr?.trim());

    if (restore.status === 0) {
      try {
        const db = new DatabaseSync(DB_PATH);
        const row = db.prepare("SELECT email, role FROM users WHERE email = ?").get(TEST_EMAIL);
        db.close();
        record("restored database still has the seeded user", Boolean(row), row ? `${row.email} (${row.role})` : "no row found");
      } catch (err) {
        fail("restored database still has the seeded user", String(err));
      }
    } else {
      fail("restored database still has the seeded user", "skipped, restore failed");
    }
  } else {
    fail("restore-db.mjs restores the snapshot", "skipped, backup failed");
    fail("restored database still has the seeded user", "skipped, backup failed");
  }

  safeRemove(TMP_ROOT);
  printSummaryAndExit();
}

function printSummaryAndExit() {
  console.log("");
  console.log("=== Summary ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} - ${r.name}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log("");
  console.log(failed.length === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failed.length} of ${results.length} CHECKS FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  safeRemove(TMP_ROOT);
  process.exit(1);
});
