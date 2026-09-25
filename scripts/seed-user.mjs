#!/usr/bin/env node
// Seed or update a user. Password comes from env SEED_PASSWORD only (never a flag,
// never printed). Uses the same scrypt format as app/lib/session.ts:
// scrypt$<saltHex>$<hashHex>, 16-byte salt, 64-byte derived key.
//
// Usage:
//   SEED_PASSWORD="at least 12 chars" node scripts/seed-user.mjs --email owner@yourfirm.example --name "Full Name" --role owner

import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      out[key] = val;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const email = (args.email || "").trim().toLowerCase();
const name = (args.name || "").trim();
const role = (args.role || "").trim();

const VALID_ROLES = new Set(["owner", "principal", "member"]);

if (!email || !name || !role) {
  console.error('Usage: node scripts/seed-user.mjs --email x --name "N" --role owner|principal|member');
  process.exit(1);
}
if (!VALID_ROLES.has(role)) {
  console.error(`Invalid role "${role}". Must be one of: owner, principal, member.`);
  process.exit(1);
}

const password = process.env.SEED_PASSWORD;
if (!password || password.length < 12) {
  console.error("Refusing: set SEED_PASSWORD in the environment (12+ characters).");
  process.exit(1);
}

function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

const DB_PATH = process.env.HARNESS_DB_PATH || path.join(process.cwd(), "data", "harness.db");
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','principal','member')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const passwordHash = hashPassword(password);

const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
if (existing) {
  db.prepare("UPDATE users SET name = ?, role = ?, password_hash = ? WHERE email = ?").run(
    name,
    role,
    passwordHash,
    email
  );
} else {
  db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)").run(
    email,
    name,
    role,
    passwordHash
  );
}

console.log(`Seeded user: ${email} (${role})`);
