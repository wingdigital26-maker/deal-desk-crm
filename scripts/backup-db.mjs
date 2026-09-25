#!/usr/bin/env node
// Snapshot the live database via VACUUM INTO (a consistent copy even while
// the app is running under WAL) into backups/harness-YYYYMMDD-HHMM.db, then
// prune anything beyond the newest 30 backups. Refuses to run against demo.db.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const DB_PATH = process.env.HARNESS_DB_PATH || path.join(process.cwd(), "data", "harness.db");
const BACKUP_DIR = path.join(process.cwd(), "backups");
const KEEP = 30;

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

function main() {
  const base = path.basename(DB_PATH).toLowerCase();
  if (base === "demo.db") {
    console.error(`Refusing to back up ${DB_PATH}: this is the demo database, not the live one.`);
    process.exit(1);
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const outPath = path.join(BACKUP_DIR, `harness-${stamp()}.db`);

  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const size = statSync(outPath).size;
  console.log(`Backup created: ${outPath}`);
  console.log(`Size: ${size} bytes / ${(size / 1024).toFixed(1)} KB / ${(size / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`(${formatSize(size)})`);

  pruneOldBackups();
}

function pruneOldBackups() {
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => /^harness-\d{8}-\d{4}\.db$/.test(f))
    .map((f) => ({ f, full: path.join(BACKUP_DIR, f), mtime: statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = files.slice(KEEP);
  for (const f of toDelete) {
    unlinkSync(f.full);
    console.log(`Pruned old backup: ${f.f}`);
  }
}

main();
