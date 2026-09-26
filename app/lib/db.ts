// Local-first data layer on Node's built-in SQLite (no native deps, no account).
// The schema below is the contract every section codes against. A hosted
// Postgres migration can mirror it later; keep SQL portable (no SQLite-only tricks
// beyond AUTOINCREMENT and datetime('now')).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { isDemo, demoDbPath } from "./demo";

// Demo mode (DEAL_DESK_DEMO=1) always runs on a scratch copy of the bundled
// fictional workspace, whatever HARNESS_DB_PATH says. Resolved lazily so the
// copy happens on the first db() call, not at import.
let _dbPath: string | null = null;
function resolveDbPath(): string {
  if (_dbPath) return _dbPath;
  _dbPath = isDemo() ? demoDbPath() : process.env.HARNESS_DB_PATH || path.join(process.cwd(), "data", "harness.db");
  return _dbPath;
}

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
-- Deal team: many users per deal, each with a role. deals.owner_user_id stays
-- the creator; the team is who works the mandate.
CREATE TABLE IF NOT EXISTS deal_team (
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'execution' CHECK (role IN ('lead','coverage','execution','analyst','other')),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (deal_id, user_id)
);
-- P2 BUYERS. A buyer is a company with a 1:1 buyer profile (SPEC_BUYER_LOG s.0).
CREATE TABLE IF NOT EXISTS buyer_profiles (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  buyer_type TEXT NOT NULL DEFAULT 'strategic' CHECK (buyer_type IN ('pe','strategic','family-office','other')),
  check_size_low INTEGER, check_size_high INTEGER,       -- dollars
  ebitda_fit_low INTEGER, ebitda_fit_high INTEGER,       -- dollars
  thesis TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Per-mandate buyer log: one row per (deal, buyer). Stage set settled 2026-09-25.
-- declined keeps where the buyer dropped out (declined_from_stage) and why.
-- Buyers are soft-removed (removed_at), never deleted, so history survives.
CREATE TABLE IF NOT EXISTS deal_buyers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  buyer_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  lead_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'teaser_sent' CHECK (stage IN
    ('teaser_sent','nda_sent','nda_signed','cim_sent','ioi','mgmt_meeting','loi','exclusivity','closed','declined')),
  declined_from_stage TEXT,
  decline_reason TEXT,
  -- First time each milestone was reached. Set once, never overwritten.
  teaser_sent_at TEXT, nda_sent_at TEXT, nda_signed_at TEXT, cim_sent_at TEXT, ioi_at TEXT,
  mgmt_meeting_at TEXT, loi_at TEXT, exclusivity_at TEXT, closed_at TEXT, declined_at TEXT,
  -- Terms (dollars / percent / days). Every edit logs the old value in deal_buyer_revisions.
  ioi_low INTEGER, ioi_high INTEGER, loi_value INTEGER,
  cash_at_close_pct REAL, rollover_pct REAL, earnout TEXT, financing TEXT,
  diligence_days INTEGER, exclusivity_days INTEGER, structure_notes TEXT, notes TEXT,
  owner_user_id INTEGER REFERENCES users(id),
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS deal_buyers_unique ON deal_buyers(deal_id, buyer_company_id);
CREATE INDEX IF NOT EXISTS deal_buyers_by_buyer ON deal_buyers(buyer_company_id);
-- Append-only (17a-4(f)(2)(i) audit-trail alternative). No UPDATE or DELETE is
-- ever issued, and RESTRICT stops a cascade from erasing it.
CREATE TABLE IF NOT EXISTS deal_buyer_stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_buyer_id INTEGER NOT NULL REFERENCES deal_buyers(id) ON DELETE RESTRICT,
  from_stage TEXT, to_stage TEXT NOT NULL, note TEXT,
  changed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS deal_buyer_stage_history_by_buyer ON deal_buyer_stage_history(deal_buyer_id);
-- Append-only: the old and new value of every term edit, so any prior state can be recreated.
CREATE TABLE IF NOT EXISTS deal_buyer_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_buyer_id INTEGER NOT NULL REFERENCES deal_buyers(id) ON DELETE RESTRICT,
  field TEXT NOT NULL, old_value TEXT, new_value TEXT,
  changed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS deal_buyer_revisions_by_buyer ON deal_buyer_revisions(deal_buyer_id);
-- P4 DOCUMENTS. Versioned, never overwritten, never deleted (17a-4: a complete
-- time-stamped trail that can recreate originals). doc_key groups the versions
-- of one logical document; a new upload to a doc_key is version N+1. Bytes live
-- on disk content-addressed by sha256 (app/lib/files.ts). "Archive" only hides.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE RESTRICT,
  deal_buyer_id INTEGER REFERENCES deal_buyers(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('engagement_letter','nda','teaser','cim','loi','financials','other')),
  title TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  note TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (doc_key, version)
);
CREATE INDEX IF NOT EXISTS documents_by_deal ON documents(deal_id, doc_key);
CREATE INDEX IF NOT EXISTS documents_by_buyer ON documents(deal_buyer_id);
CREATE TRIGGER IF NOT EXISTS documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS documents_immutable_file BEFORE UPDATE OF deal_id, deal_buyer_id, kind, doc_key, version, filename, mime, size, sha256, uploaded_by, created_at ON documents
BEGIN SELECT RAISE(ABORT, 'a stored document version cannot be rewritten'); END;
-- END P4 DOCUMENTS.
-- P3 RELATIONSHIPS. A contact can hold roles at many companies over time
-- (a CPA who also sits on an owner's board). contacts.company_id stays the
-- current primary company; the link marked is_primary always matches it.
CREATE TABLE IF NOT EXISTS contact_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role TEXT, start_date TEXT, end_date TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (contact_id, company_id)
);
CREATE INDEX IF NOT EXISTS contact_companies_by_company ON contact_companies(company_id);
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
-- Auto-capture dedupe (Outlook / Graph, off by default): one row per (item, contact) already written to the timeline.
CREATE TABLE IF NOT EXISTS captured_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  contact_id INTEGER,
  activity_id INTEGER REFERENCES activities(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, external_id, contact_id)
);
-- ---- P5 BANK / FIG REGULATORY TRACK ----
-- Working trackers for a bank or credit union deal (turned on per deal by
-- deals.fig_track). Dates are YYYY-MM-DD. Not books and records: rows may be
-- deleted, and every add, edit and delete is audited with the full old row.
CREATE TABLE IF NOT EXISTS deal_regulatory_filings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  regulator TEXT NOT NULL CHECK (regulator IN ('FDIC','OCC','FED','STATE','NCUA')),
  agency_label TEXT,
  filed_at TEXT, accepted_complete_at TEXT, public_notice_at TEXT, comment_end_at TEXT,
  approval_at TEXT,
  doj_concurrence INTEGER NOT NULL DEFAULT 0,
  consummation_eligible_at TEXT,
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','filed','accepted','approved','withdrawn','denied')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (deal_id, regulator, agency_label)
);
CREATE INDEX IF NOT EXISTS deal_regulatory_filings_by_deal ON deal_regulatory_filings(deal_id);
CREATE TABLE IF NOT EXISTS deal_shareholder_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  party TEXT NOT NULL CHECK (party IN ('target','acquirer')),
  record_date TEXT, notice_mailed_at TEXT, meeting_at TEXT,
  result TEXT DEFAULT 'pending' CHECK (result IN ('pending','approved','rejected')),
  votes_for_pct REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (deal_id, party)
);
-- ---- end P5 ----
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
  // P1 deal economics (dollars as whole numbers; pct and probability 0-100).
  // Internal-only: fee words are banned from outbound COPY, not from deal data.
  ["deals", "fee_terms", "TEXT"],
  ["deals", "retainer", "INTEGER"],
  ["deals", "success_fee_pct", "REAL"],
  ["deals", "ebitda", "INTEGER"],
  ["deals", "enterprise_value", "INTEGER"],
  ["deals", "expected_close", "TEXT"],
  ["deals", "probability", "INTEGER"],
  // Touch cadence: remind on Today when a relationship goes quiet this long.
  ["contacts", "touch_every_days", "INTEGER"],
  // ---- P5 BANK / FIG: 1 turns on the regulatory approval tracker for a deal ----
  ["deals", "fig_track", "INTEGER NOT NULL DEFAULT 0"],
  // P3 relationships: referral sources are contacts with a kind; a deal credits one.
  // referral_kind: cpa | attorney | wealth-manager | lender | banker | other (null = not a source).
  ["contacts", "referral_kind", "TEXT"],
  // Plain INTEGER (ALTER TABLE cannot add a real FK everywhere): the contact
  // DELETE route clears it, and every read LEFT JOINs contacts.
  ["deals", "referral_contact_id", "INTEGER"],
];

function migrate(d: DatabaseSync) {
  for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS outbound_unsub_token ON outbound_messages(unsubscribe_token) WHERE unsubscribe_token IS NOT NULL");
  // P3: every contacts.company_id is also a primary link in contact_companies.
  // INSERT OR IGNORE on the UNIQUE pair makes this safe to run on every open;
  // the second statement keeps is_primary in step with contacts.company_id
  // (touching only rows that disagree).
  d.exec("CREATE INDEX IF NOT EXISTS deals_by_referral ON deals(referral_contact_id)");
  d.exec(
    `INSERT OR IGNORE INTO contact_companies (contact_id, company_id, is_primary)
     SELECT id, company_id, 1 FROM contacts WHERE company_id IS NOT NULL`
  );
  d.exec(
    `UPDATE contact_companies SET is_primary = 1 - is_primary
     WHERE is_primary != (CASE WHEN company_id = (SELECT c.company_id FROM contacts c WHERE c.id = contact_companies.contact_id) THEN 1 ELSE 0 END)`
  );
}

let _db: DatabaseSync | null = null;

/** Where the database file lives, for the Python scrapers the app shells out to. */
export const dbPath = () => resolveDbPath();

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
  const file = resolveDbPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
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
