#!/usr/bin/env node
// Restore a backup over the live database. Requires --yes. Before overwriting,
// takes a timestamped safety copy of the CURRENT database (same snapshot
// approach as backup-db.mjs, node:sqlite backup() when available, else
// VACUUM INTO) so a bad restore is itself recoverable. If a matching
// harness-files-<stamp> directory sits next to the chosen backup, its
// contents are restored over HARNESS_FILES_DIR too.
//
// Usage:
//   node scripts/restore-db.mjs backups/harness-20260925-0130.db --yes
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const DB_PATH = process.env.HARNESS_DB_PATH || path.join(process.cwd(), "data", "harness.db");
const FILES_DIR = process.env.HARNESS_FILES_DIR || "";
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), "backups");

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function snapshotDb(dbPath, outPath) {
  const db = new DatabaseSync(dbPath);
  try {
    if (typeof db.backup === "function") {
      await db.backup(outPath);
      return;
    }
    db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

// Best-effort check: a live app holds a WAL/SHM file open next to the main
// db file while it has the database open. Their presence does not prove the
// app is running right now (WAL files can linger after a clean shutdown),
// so this is a warning, not a hard stop; there is no portable way from a
// plain Node script to know for certain another process has DB_PATH open.
function warnIfLikelyOpen(dbPath) {
  const wal = `${dbPath}-wal`;
  const shm = `${dbPath}-shm`;
  if (existsSync(wal) || existsSync(shm)) {
    console.warn(
      `Warning: ${path.basename(wal)} and/or ${path.basename(shm)} exist next to ${dbPath}. ` +
        "That usually means the app has this database open. Stop the app before restoring, " +
        "or writes made during/after this restore could be lost or the database left inconsistent."
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const fileArg = args.find((a) => !a.startsWith("--"));

  if (!fileArg) {
    console.error("Usage: node scripts/restore-db.mjs <backup-file> --yes");
    process.exit(1);
  }
  if (!yes) {
    console.error("Refusing to restore without --yes. This overwrites the live database.");
    process.exit(1);
  }

  const source = path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg);
  if (!existsSync(source)) {
    console.error(`Backup file not found: ${source}`);
    process.exit(1);
  }

  warnIfLikelyOpen(DB_PATH);

  mkdirSync(BACKUP_DIR, { recursive: true });

  if (existsSync(DB_PATH)) {
    const safetyPath = path.join(BACKUP_DIR, `pre-restore-safety-${stamp()}.db`);
    await snapshotDb(DB_PATH, safetyPath);
    console.log(`Safety copy of the current database written to: ${safetyPath}`);
  } else {
    console.log(`No existing database at ${DB_PATH}; skipping safety copy.`);
  }

  // Restore into a temp file first and rename into place, so a crash or
  // interrupted copy never leaves DB_PATH half-written.
  const tmpPath = `${DB_PATH}.restoring-${stamp()}`;
  copyFileSync(source, tmpPath);
  renameSync(tmpPath, DB_PATH);
  const size = statSync(DB_PATH).size;
  console.log(`Restored ${source} over ${DB_PATH} (${(size / 1024).toFixed(1)} KB).`);

  // Clean up any leftover WAL/SHM from the old database file; the restored
  // file is a fresh single-file snapshot and stale WAL/SHM would shadow it.
  for (const suffix of ["-wal", "-shm"]) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) {
      rmSync(p, { force: true });
      console.log(`Removed stale ${path.basename(p)} from the previous database.`);
    }
  }

  // If this backup has a matching files snapshot (harness-files-<stamp>
  // next to harness-<stamp>.db), restore it too when HARNESS_FILES_DIR is set.
  const base = path.basename(source);
  const match = base.match(/^harness-(\d{8}-\d{4})\.db$/);
  if (match && FILES_DIR) {
    const filesSnapshot = path.join(path.dirname(source), `harness-files-${match[1]}`);
    if (existsSync(filesSnapshot)) {
      if (existsSync(FILES_DIR)) {
        const safetyFilesDir = path.join(BACKUP_DIR, `pre-restore-safety-files-${stamp()}`);
        cpSync(FILES_DIR, safetyFilesDir, { recursive: true });
        console.log(`Safety copy of current files written to: ${safetyFilesDir}`);
        rmSync(FILES_DIR, { recursive: true, force: true });
      }
      cpSync(filesSnapshot, FILES_DIR, { recursive: true });
      console.log(`Restored files from ${filesSnapshot} to ${FILES_DIR}.`);
    }
  }
}

main();
