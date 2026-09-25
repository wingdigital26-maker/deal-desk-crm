#!/usr/bin/env node
// Restore a backup over the live database. Requires --yes. Before overwriting,
// takes a timestamped safety copy of the CURRENT database (same VACUUM INTO
// approach as backup-db.mjs) so a bad restore is itself recoverable.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const DB_PATH = process.env.HARNESS_DB_PATH || path.join(process.cwd(), "data", "harness.db");
const BACKUP_DIR = path.join(process.cwd(), "backups");

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function main() {
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

  mkdirSync(BACKUP_DIR, { recursive: true });

  if (existsSync(DB_PATH)) {
    const safetyPath = path.join(BACKUP_DIR, `pre-restore-safety-${stamp()}.db`);
    const db = new DatabaseSync(DB_PATH);
    try {
      db.exec(`VACUUM INTO '${safetyPath.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    console.log(`Safety copy of the current database written to: ${safetyPath}`);
  } else {
    console.log(`No existing database at ${DB_PATH}; skipping safety copy.`);
  }

  copyFileSync(source, DB_PATH);
  const size = statSync(DB_PATH).size;
  console.log(`Restored ${source} over ${DB_PATH} (${(size / 1024).toFixed(1)} KB).`);
}

main();
