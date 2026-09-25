// Local-first data layer on Node's built-in SQLite (no native deps, no account).
// The schema below is the contract every section codes against. A hosted
// Postgres migration can mirror it later; keep SQL portable (no SQLite-only tricks
// beyond AUTOINCREMENT and datetime('now')).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DB_PATH = process.env.HARNESS_DB_PATH || path.join(process.cwd(), "data", "harness.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','principal','member')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT,
  segment_id TEXT NOT NULL DEFAULT 'owners',
  industry TEXT, city TEXT, state TEXT,
  employees INTEGER, revenue_band TEXT,
  source TEXT NOT NULL DEFAULT 'manual',   -- manual | apollo | signal-engine | import
  signal_score REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_domain ON companies(domain) WHERE domain IS NOT NULL;
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  first_name TEXT, last_name TEXT, title TEXT,
  email TEXT, email_status TEXT,           -- valid | accept-all | mx-only | no-mx | unknown
  phone TEXT, linkedin_url TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  apollo_id TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email ON contacts(email) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  primary_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'Sourced',
  situation TEXT,                          -- growth-partner | succession | strategic-transition | other
  next_step TEXT, next_step_due TEXT,
  owner_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, due TEXT, done INTEGER NOT NULL DEFAULT 0,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activities (     -- the timeline
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                       -- note | call | email-out | email-in | stage-change | signal | import
  body TEXT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS signals (        -- from the Python signal engine
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- hiring | news | filing | contract | recall | other
  title TEXT NOT NULL, url TEXT, observed_at TEXT,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- OUTBOUND. Compliance model: content is approved by a PRINCIPAL, and the
-- approval is bound to a content hash. Any edit changes the hash and voids it.
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL,   -- may contain {{merge_fields}}
  allowed_merge_fields TEXT NOT NULL DEFAULT '["first_name","company_name"]',
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected','retired')),
  approved_by INTEGER REFERENCES users(id), approved_at TEXT, review_note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS outbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES templates(id),
  template_hash TEXT NOT NULL,                 -- hash of the template at queue time
  merge_json TEXT NOT NULL DEFAULT '{}',
  rendered_subject TEXT NOT NULL, rendered_body TEXT NOT NULL,
  lint_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','held','sent','failed','cancelled')),
  mailbox TEXT, scheduled_for TEXT, sent_at TEXT, provider_id TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'apollo',
  warmup_started TEXT,                         -- date warmup began; null = not started
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS suppression (
  email TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Replies, bounces and unsubscribes read back from the sending provider.
CREATE TABLE IF NOT EXISTS inbound_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT UNIQUE,                     -- provider's message id; makes the sync idempotent
  message_id INTEGER REFERENCES outbound_messages(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  from_email TEXT NOT NULL,
  subject TEXT, snippet TEXT,
  kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','bounce','unsubscribe','auto-reply')),
  handled INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Append-only record (FINRA 17a-4) of every approved message handed to an
-- external sender such as Instantly: the exact text pushed, never updated.
CREATE TABLE IF NOT EXISTS outbound_pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER REFERENCES outbound_messages(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  campaign_id TEXT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  provider_ref TEXT,
  pushed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Small key/value cursors for pollers (e.g. the Instantly reply poll).
CREATE TABLE IF NOT EXISTS sync_cursors (
  name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS login_attempts (   -- rate limiting that survives restarts and multiple instances
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS login_attempts_bucket ON login_attempts(bucket, created_at);
-- Append-only. No UPDATE or DELETE is ever issued against this table.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER, actor_label TEXT,
  action TEXT NOT NULL,                        -- template.submit | template.approve | template.reject | message.queue | message.send | message.block | login | import ...
  entity TEXT, entity_id INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Banker profile (owner + business), one sourced fact per row, written by
-- scrapers/profile_enrich.py. Every row carries the URL it came from and when it
-- was fetched. confidence = confirmed (tied by domain, registry id, or name plus
-- city/state) | unconfirmed (name match only; the UI labels it). List fields
-- (locations, certifications, signals ...) hold one row per value, keyed by
-- value_key; single fields use value_key ''. The script never writes a blank
-- and never lets an unconfirmed value replace a confirmed one.
CREATE TABLE IF NOT EXISTS profile_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('company','contact')),
  entity_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  value_key TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL,
  source_label TEXT,
  confidence TEXT NOT NULL DEFAULT 'confirmed' CHECK (confidence IN ('confirmed','unconfirmed')),
  match_basis TEXT,
  note TEXT,
  observed_at TEXT,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS profile_facts_key ON profile_facts(entity, entity_id, field, value_key);
CREATE INDEX IF NOT EXISTS profile_facts_entity ON profile_facts(entity, entity_id);
`;

// Additive, idempotent column migrations for databases created by an earlier schema.
const COLUMN_MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ["outbound_messages", "unsubscribe_token", "TEXT"],
  ["outbound_messages", "rendered_footer", "TEXT"],
  ["outbound_messages", "replied_at", "TEXT"],
  ["contacts", "enriched_at", "TEXT"],
  ["contacts", "unsubscribed_at", "TEXT"],
  ["users", "disabled", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "must_change_password", "INTEGER NOT NULL DEFAULT 0"],
  // Full inbound text kept verbatim (never overwritten) for the firm's records.
  ["inbound_replies", "body", "TEXT"],
  ["inbound_replies", "provider", "TEXT"],
  ["inbound_replies", "thread_id", "TEXT"],
  ["inbound_replies", "to_email", "TEXT"],
  ["mailboxes", "domain", "TEXT"],
  ["mailboxes", "daily_cap", "INTEGER"],               // provider-side daily limit; tightens the ramp, never loosens it
  ["companies", "profile_refreshed_at", "TEXT"],
];

function migrate(d: DatabaseSync) {
  for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS outbound_unsub_token ON outbound_messages(unsubscribe_token) WHERE unsubscribe_token IS NOT NULL");
}

let _db: DatabaseSync | null = null;

/** Where the database file lives, for the Python scrapers the app shells out to. */
export const dbPath = () => DB_PATH;

// node:sqlite returns rows with a null prototype. React refuses to pass those
// from a server component to a client component, so every row is copied into a
// plain object here, once, instead of in every page.
function plainRows(d: DatabaseSync): DatabaseSync {
  const prepare = d.prepare.bind(d);
  d.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    const all = stmt.all.bind(stmt);
    const get = stmt.get.bind(stmt);
    stmt.all = ((...args: Parameters<typeof all>) => all(...args).map((r) => ({ ...r }))) as typeof stmt.all;
    stmt.get = ((...args: Parameters<typeof get>) => {
      const r = get(...args);
      return r === undefined ? undefined : { ...r };
    }) as typeof stmt.get;
    return stmt;
  }) as typeof d.prepare;
  return d;
}

export function db(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  d.exec(SCHEMA);
  migrate(d);
  _db = plainRows(d);
  return _db;
}

export function audit(entry: {
  actorUserId?: number | null;
  actorLabel?: string;
  action: string;
  entity?: string;
  entityId?: number | null;
  detail?: Record<string, unknown>;
}) {
  db()
    .prepare(
      "INSERT INTO audit_log (actor_user_id, actor_label, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?,?)"
    )
    .run(
      entry.actorUserId ?? null,
      entry.actorLabel ?? null,
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      JSON.stringify(entry.detail ?? {})
    );
}
