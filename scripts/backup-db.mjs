#!/usr/bin/env node
// Snapshot the live database into BACKUP_DIR/harness-YYYYMMDD-HHMM.db, then
// prune anything beyond the newest BACKUP_KEEP backups (default 14). Also
// copies HARNESS_FILES_DIR (uploaded deal documents, a later package) next
// to the database snapshot if that directory exists. Refuses to run against
// demo.db.
//
// Uses node:sqlite's DatabaseSync#backup() when it is available (the online
// backup API, safe to run against a live database), and falls back to
// VACUUM INTO on Node versions where DatabaseSync#backup() does not exist
// yet. Both produce a consistent copy even while the app is running under
// WAL.
//
// Env:
//   HARNESS_DB_PATH   path to the live database (default data/harness.db)
//   HARNESS_FILES_DIR path to uploaded documents, optional
//   BACKUP_DIR        where snapshots go (default ./backups)
//   BACKUP_KEEP       how many db snapshots to keep (default 14)
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const DB_PATH = process.env.HARNESS_DB_PATH || path.join(process.cwd(), "data", "harness.db");
const FILES_DIR = process.env.HARNESS_FILES_DIR || "";
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
const KEEP = Number.parseInt(process.env.BACKUP_KEEP || "14", 10) || 14;

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

// Snapshots DB_PATH into outPath. Prefers the online backup API
// (DatabaseSync#backup), falls back to VACUUM INTO on older Node builds.
async function snapshotDb(outPath) {
  const db = new DatabaseSync(DB_PATH);
  try {
    if (typeof db.backup === "function") {
      await db.backup(outPath);
      return "backup()";
    }
    db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
    return "VACUUM INTO";
  } finally {
    db.close();
  }
}

async function main() {
  const base = path.basename(DB_PATH).toLowerCase();
  if (base === "demo.db") {
    console.error(`Refusing to back up ${DB_PATH}: this is the demo database, not the live one.`);
    process.exit(1);
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const s = stamp();
  const outPath = path.join(BACKUP_DIR, `harness-${s}.db`);

  const method = await snapshotDb(outPath);

  const size = statSync(outPath).size;
  console.log(`Backup created: ${outPath} (via ${method})`);
  console.log(`Size: ${size} bytes / ${(size / 1024).toFixed(1)} KB / ${(size / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`(${formatSize(size)})`);

  if (FILES_DIR && existsSync(FILES_DIR)) {
    const filesOut = path.join(BACKUP_DIR, `harness-files-${s}`);
    cpSync(FILES_DIR, filesOut, { recursive: true });
    console.log(`Files snapshot created: ${filesOut} (copied from ${FILES_DIR})`);
  } else if (FILES_DIR) {
    console.log(`HARNESS_FILES_DIR is set to ${FILES_DIR} but it does not exist yet; nothing to copy.`);
  }

  pruneOldBackups();

  console.log("");
  console.log("This backup lives on the same box as the app. Copy it off-box too:");
  console.log("  Fly.io:    fly sftp get <path-under-/app/data or /app/backups> from a machine, or");
  console.log("             point a small scheduled Fly Machine at this same volume and push the");
  console.log("             file to encrypted storage you control from there.");
  console.log("  Railway:   Railway volumes are not exported automatically; use `railway run` to");
  console.log("             exec into the service and copy the backup out over SSH/SFTP, or take a");
  console.log("             volume snapshot from the Railway dashboard if the plan offers one.");
  console.log("  Either way: this script does not upload anywhere by itself. See");
  console.log("             docs/HOSTED-DEPLOY.md for the manual steps.");
}

function pruneOldBackups() {
  const dbFiles = readdirSync(BACKUP_DIR)
    .filter((f) => /^harness-\d{8}-\d{4}\.db$/.test(f))
    .map((f) => ({ f, full: path.join(BACKUP_DIR, f), mtime: statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = dbFiles.slice(KEEP);
  for (const f of toDelete) {
    unlinkSync(f.full);
    console.log(`Pruned old backup: ${f.f}`);

    // A files snapshot shares the same timestamp as its db snapshot; prune together.
    const filesDir = f.f.replace(/^harness-/, "harness-files-").replace(/\.db$/, "");
    const filesFull = path.join(BACKUP_DIR, filesDir);
    if (existsSync(filesFull)) {
      rmSync(filesFull, { recursive: true, force: true });
      console.log(`Pruned old files snapshot: ${filesDir}`);
    }
  }
}

main();
