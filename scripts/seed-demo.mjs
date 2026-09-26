#!/usr/bin/env node
// Seeds data/demo.db with a full, realistic, fictional workspace for design
// review. Never touches data/harness.db except to READ the two login users'
// password hashes (if present) so the same sign-in works in the demo.
//
// Usage:
//   node scripts/seed-demo.mjs
//   SEED_PASSWORD="at least 12 chars" node scripts/seed-demo.mjs   (used only if harness.db is absent)

import { DatabaseSync } from "node:sqlite";
import { createHash, scryptSync } from "node:crypto";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// 0. Paths + safety rails
// ---------------------------------------------------------------------------
const DEMO_DB_PATH = process.env.HARNESS_DEMO_DB_PATH || path.join(ROOT, "data", "demo.db");
const REAL_DB_PATH = path.join(ROOT, "data", "harness.db");

if (path.basename(DEMO_DB_PATH) !== "demo.db") {
  console.error(`Refusing: target path must end in "demo.db". Got: ${DEMO_DB_PATH}`);
  process.exit(1);
}
if (path.resolve(DEMO_DB_PATH) === path.resolve(REAL_DB_PATH)) {
  console.error("Refusing: demo target resolves to the real database path.");
  process.exit(1);
}

mkdirSync(path.dirname(DEMO_DB_PATH), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  const p = DEMO_DB_PATH + suffix;
  if (existsSync(p)) rmSync(p);
}

// ---------------------------------------------------------------------------
// 1. Extract the exact SCHEMA DDL from app/lib/db.ts so it never drifts.
// ---------------------------------------------------------------------------
const dbTsPath = path.join(ROOT, "app", "lib", "db.ts");
const dbTsSrc = readFileSync(dbTsPath, "utf8");
const schemaMatch = dbTsSrc.match(/const SCHEMA = `([\s\S]*?)`;/);
if (!schemaMatch) {
  console.error(
    "Could not extract the SCHEMA template string from app/lib/db.ts. " +
      "The file may have changed shape; update the extraction regex in scripts/seed-demo.mjs."
  );
  process.exit(1);
}
const SCHEMA = schemaMatch[1];

// Extract COLUMN_MIGRATIONS (additive, idempotent column adds applied by
// db.ts's migrate()) so the demo db gets the same columns a real, migrated
// harness.db would have, even though SCHEMA alone does not include them.
const migrationsMatch = dbTsSrc.match(/COLUMN_MIGRATIONS[^=]*=\s*(\[[\s\S]*?\]);/);
if (!migrationsMatch) {
  console.error(
    "Could not extract COLUMN_MIGRATIONS from app/lib/db.ts. The file may have changed shape; " +
      "update the extraction regex in scripts/seed-demo.mjs."
  );
  process.exit(1);
}
let COLUMN_MIGRATIONS;
try {
  // eslint-disable-next-line no-new-func
  COLUMN_MIGRATIONS = Function(`"use strict"; return (${migrationsMatch[1]});`)();
} catch (err) {
  console.error("Could not parse the COLUMN_MIGRATIONS array literal from app/lib/db.ts: " + err.message);
  process.exit(1);
}
if (
  !Array.isArray(COLUMN_MIGRATIONS) ||
  COLUMN_MIGRATIONS.length === 0 ||
  COLUMN_MIGRATIONS.some((m) => !Array.isArray(m) || m.length !== 3 || m.some((v) => typeof v !== "string"))
) {
  console.error(
    "COLUMN_MIGRATIONS in app/lib/db.ts no longer looks like an array of [table, column, ddl] string triples. " +
      "Update scripts/seed-demo.mjs to match."
  );
  process.exit(1);
}

// Confirm the unsubscribe_token unique index DDL is still there verbatim, and
// pull it out so the demo db gets the identical index.
const unsubIndexMatch = dbTsSrc.match(
  /CREATE UNIQUE INDEX IF NOT EXISTS outbound_unsub_token ON outbound_messages\(unsubscribe_token\) WHERE unsubscribe_token IS NOT NULL/
);
if (!unsubIndexMatch) {
  console.error(
    "Could not find the outbound_unsub_token unique index DDL in app/lib/db.ts. " +
      "Update the extraction regex in scripts/seed-demo.mjs."
  );
  process.exit(1);
}
const UNSUB_TOKEN_INDEX_DDL = unsubIndexMatch[0];

// ---------------------------------------------------------------------------
// 2. Extract contentHash canonicalization from app/lib/compliance/index.ts so
//    the demo replicates it exactly without importing TS at runtime. It now
//    also covers the legal footer template (4th param, defaulting to
//    footerTemplate()), built from firm.config.ts's outbound.footer with the
//    firm name and mailing address filled in.
// ---------------------------------------------------------------------------
const complianceSrc = readFileSync(path.join(ROOT, "app", "lib", "compliance", "index.ts"), "utf8");
if (
  !/footer:\s*string\s*=\s*footerTemplate\(\)/.test(complianceSrc) ||
  !/JSON\.stringify\(\{\s*subject: normalizeNewlines\(subject\),\s*body: normalizeNewlines\(body\),\s*fields: \[\.\.\.allowedMergeFields\]\.sort\(\),\s*footer: normalizeNewlines\(footer\),\s*\}\)/.test(
    complianceSrc
  )
) {
  console.error(
    "contentHash canonicalization in app/lib/compliance/index.ts no longer matches the shape " +
      "this script replicates. Update contentHash()/normalizeNewlines()/footerTemplate() below to match."
  );
  process.exit(1);
}

// Pull the firm's name / mailing address / footer template string out of
// firm.config.ts so footerTemplate() below matches app/lib/compliance's
// footerTemplate() exactly without importing TS at runtime.
const firmConfigSrc = readFileSync(path.join(ROOT, "firm.config.ts"), "utf8");
function extractFirmStringField(key) {
  const m = firmConfigSrc.match(new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) {
    console.error(`Could not extract firm.config.ts field "${key}". Update the extraction regex in scripts/seed-demo.mjs.`);
    process.exit(1);
  }
  return JSON.parse(`"${m[1]}"`);
}
const FIRM_NAME = extractFirmStringField("name");
const FIRM_MAILING_ADDRESS = extractFirmStringField("mailingAddress");
const FIRM_FOOTER_RAW = extractFirmStringField("footer");

// firm.sender.name/title are computed (demoOverride(...)) rather than string
// literals, so they can't go through extractFirmStringField above. Mirror the
// same override logic here instead, so the seeded owner user and the sample
// template sign-offs match whatever the hosted demo will actually show.
function demoOverride(envVar, fallback) {
  if (process.env.DEAL_DESK_DEMO !== "1") return fallback;
  const v = process.env[envVar];
  return v && v.trim() ? v.trim() : fallback;
}
const FIRM_SENDER_NAME = demoOverride("DEMO_OWNER_NAME", "Jordan Hale");
const FIRM_SENDER_TITLE = demoOverride("DEMO_OWNER_TITLE", "Managing Director");

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
/** Mirrors app/lib/compliance/index.ts footerTemplate(). */
function footerTemplate() {
  return FIRM_FOOTER_RAW.replace(/{{\s*firm_name\s*}}/g, FIRM_NAME).replace(/{{\s*mailing_address\s*}}/g, FIRM_MAILING_ADDRESS);
}
function contentHash(subject, body, allowedMergeFields, footer = footerTemplate()) {
  const canonical = JSON.stringify({
    subject: normalizeNewlines(subject),
    body: normalizeNewlines(body),
    fields: [...allowedMergeFields].sort(),
    footer: normalizeNewlines(footer),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
// Self-check against a known input, per the brief.
{
  const h1 = contentHash("Hello {{first_name}}", "Body text", ["first_name", "company_name"]);
  const h2 = contentHash("Hello {{first_name}}", "Body text", ["company_name", "first_name"]);
  if (h1 !== h2) {
    console.error("contentHash self-check failed: field order should not affect the hash.");
    process.exit(1);
  }
  const h3 = contentHash("Hello {{first_name}}\r\n", "Body text\r\n", ["first_name", "company_name"]);
  const h4 = contentHash("Hello {{first_name}}\n", "Body text\n", ["first_name", "company_name"]);
  if (h3 !== h4) {
    console.error("contentHash self-check failed: CRLF should normalize the same as LF.");
    process.exit(1);
  }
  const h5 = contentHash("Hello {{first_name}}", "Body text", ["first_name"], "Footer A");
  const h6 = contentHash("Hello {{first_name}}", "Body text", ["first_name"], "Footer B");
  if (h5 === h6) {
    console.error("contentHash self-check failed: a changed footer should change the hash.");
    process.exit(1);
  }
  const h7 = contentHash("Hello {{first_name}}", "Body text", ["first_name"]);
  if (!footerTemplate().includes(FIRM_NAME) || !footerTemplate().includes(FIRM_MAILING_ADDRESS)) {
    console.error("footerTemplate() self-check failed: rendered footer is missing the firm name or mailing address.");
    process.exit(1);
  }
  void h7;
}

// Firm voice rules (mirrors firm.config.ts) used to gate generated template copy.
const FORBIDDEN_PATTERNS = [
  { id: "fees", re: /\b(fee|fees|retainer|success fee|commission|percent of|% of)\b/gi },
  { id: "sim", re: /\bSIM\b/g },
  { id: "promise", re: /\b(guarantee|guaranteed|we can get you|will sell for|worth at least)\b/gi },
  { id: "ease", re: /\b(just|simply|easily|hand them)\b/gi },
  { id: "emdash", re: /—/g },
];
function assertVoiceClean(label, text) {
  for (const rule of FORBIDDEN_PATTERNS) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) {
      console.error(`Voice rule "${rule.id}" tripped in ${label}: ${JSON.stringify(text)}`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Deterministic PRNG (mulberry32) + small helpers
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xdea1c0de);
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function pickN(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  }
  return out;
}
function randInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function randHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes * 2; i++) out += Math.floor(rand() * 16).toString(16);
  return out;
}
function randFloat(min, max, decimals = 1) {
  const v = rand() * (max - min) + min;
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}
const BASE64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const usedUnsubscribeTokens = new Set();
// Deterministic stand-in for app/lib/outbound/unsubscribe.ts's
// generateUnsubscribeToken() (randomBytes(32).toString("base64url")): same
// shape (43 URL-safe base64 chars, no padding), but drawn from the seeded
// PRNG so the whole demo workspace stays byte-identical across runs.
function makeUnsubscribeToken() {
  let token;
  do {
    let out = "";
    for (let i = 0; i < 43; i++) out += BASE64URL_CHARS[Math.floor(rand() * BASE64URL_CHARS.length)];
    token = out;
  } while (usedUnsubscribeTokens.has(token));
  usedUnsubscribeTokens.add(token);
  return token;
}
const DEMO_APP_BASE_URL = "http://localhost:4761";
// Mirrors app/lib/outbound/unsubscribe.ts's unsubscribeUrlFor().
function unsubscribeUrlFor(token) {
  return `${DEMO_APP_BASE_URL}/u/${token}`;
}
// Mirrors app/lib/compliance/index.ts's renderTemplate()'s footer construction.
function renderedFooterFor(token) {
  return footerTemplate().replace(/{{\s*unsubscribe_url\s*}}/g, unsubscribeUrlFor(token));
}
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^-+|-+$/g, "");
}

// Today, at midnight, for deterministic relative dates.
const TODAY = new Date();
TODAY.setHours(12, 0, 0, 0);
function daysFromToday(offset) {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + offset);
  return d;
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function isoDateTime(d) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ---------------------------------------------------------------------------
// 4. Fictional name pools (Texas / Southwest, founder-owned middle-market)
// ---------------------------------------------------------------------------
const CITIES = [
  ["Fort Worth", "TX"], ["Arlington", "TX"], ["Waco", "TX"], ["Tyler", "TX"],
  ["Amarillo", "TX"], ["Lubbock", "TX"], ["Abilene", "TX"], ["Odessa", "TX"],
  ["San Angelo", "TX"], ["Wichita Falls", "TX"], ["Longview", "TX"], ["Denton", "TX"],
  ["McKinney", "TX"], ["Tulsa", "OK"], ["Oklahoma City", "OK"], ["Shreveport", "LA"],
  ["Baton Rouge", "LA"], ["Little Rock", "AR"], ["Albuquerque", "NM"], ["Las Cruces", "NM"],
];

const OWNER_INDUSTRIES = [
  "Sheet metal fabrication", "Industrial coatings", "Cold-chain distribution",
  "Building products manufacturing", "Commercial HVAC services", "Food processing",
  "Specialty logistics", "Precast concrete", "Electrical distribution",
  "Packaging manufacturing", "Ag equipment distribution", "Water treatment equipment",
  "Commercial roofing supply", "Industrial hose and fittings", "Pump and valve distribution",
];

const NAME_ROOTS = [
  "Brazos", "Panhandle", "Llano", "Caprock", "Trinity", "Colorado River", "Pecos",
  "Cross Timbers", "Red River", "Guadalupe", "Concho", "Sabine", "Ouachita",
  "Canadian River", "Staked Plains", "Hill Country", "Mesquite", "Ironwood",
  "Cottonwood", "Blackland",
];
const NAME_SUFFIXES_OWNER = [
  "Fabrication", "Industries", "Manufacturing", "Distribution", "Supply Co.",
  "Coatings", "Logistics", "Equipment", "Building Products", "Processing",
];
function makeOwnerCompanyName(used) {
  let name;
  do {
    name = `${pick(NAME_ROOTS)} ${pick(NAME_SUFFIXES_OWNER)}`;
  } while (used.has(name));
  used.add(name);
  return name;
}

const REFERRAL_KINDS = [
  { label: "CPA firm", suffixes: ["& Associates CPAs", "CPA Group", "Advisory & Tax"] },
  { label: "succession attorney", suffixes: ["Law Group", "& Partners LLP", "Legal Advisors"] },
  { label: "wealth manager", suffixes: ["Wealth Partners", "Capital Advisors", "Wealth Management"] },
];
const PERSON_LAST_NAMES = [
  "Calloway", "Renner", "Ostrander", "Beauchamp", "Kinsley", "Marchetti", "Holloway",
  "Fenwick", "Delacroix", "Whitfield", "Sorensen", "Blackwood", "Tremaine", "Ashworth",
  "Corrigan", "Vandermark", "Halloran", "Pruitt", "Escamilla", "Northrup", "Dunmore",
  "Castellano", "Rourke", "Braddock", "Sinclair", "Fairweather",
];
const PERSON_FIRST_NAMES = [
  "Grant", "Mara", "Dalton", "Renata", "Colton", "Simone", "Weston", "Adele",
  "Foster", "Lucia", "Reid", "Vivian", "Trace", "Noelle", "Sawyer", "Delphine",
  "Beckett", "Isla", "Holt", "Marguerite", "Cole", "Piper", "Everett", "Wren",
];

const INSTITUTION_NAMES = [
  "Caprock State Bank", "First Panhandle Bank", "Trinity Valley Credit Union",
  "Cross Timbers Bank & Trust", "Concho Community Bank",
];

const TITLES = ["Owner", "Founder", "President", "CEO", "CFO", "Managing Partner"];
const EMAIL_STATUSES = ["valid", "valid", "valid", "accept-all", "mx-only", "unknown"];
const SOURCES = ["manual", "apollo", "signal-engine", "import"];

const SITUATIONS = ["growth-partner", "succession", "strategic-transition", "other"];

// ---------------------------------------------------------------------------
// 5. Restrained banker-voice copy fragments (short, warm, no pitch)
// ---------------------------------------------------------------------------
const NOTE_OPENERS = [
  "Caught up with", "Spoke briefly with", "Had a short call with", "Connected with",
  "Exchanged notes with", "Met for coffee with",
];
const NOTE_TOPICS = [
  "how the last quarter closed out and where headcount is trending",
  "the succession timeline and who else is involved in the decision",
  "a competitor's recent expansion and how it changes their thinking",
  "the new facility lease and what it signals about growth plans",
  "family involvement in the business and long-term intentions",
  "recent hiring in finance, which usually points to more structure ahead",
  "customer concentration and whether that has shifted this year",
  "what prompted the original outreach and what matters most to them now",
];
const NOTE_NEXT_STEPS = [
  "Next step: send a short follow-up note in a few weeks.",
  "Next step: introduce them to a colleague who covers their sector.",
  "Next step: check back after their board meets next month.",
  "Next step: none for now, they asked for space to think it over.",
  "Next step: share a relevant deal example once one clears compliance.",
  "Next step: follow up after the holidays.",
];

function makeActivityNote() {
  return `${pick(NOTE_OPENERS)} the team about ${pick(NOTE_TOPICS)}. ${pick(NOTE_NEXT_STEPS)}`;
}

const SIGNAL_KINDS = ["hiring", "news", "filing", "contract"];
const SIGNAL_TEMPLATES = {
  hiring: (co) => `${co} posts openings for a controller and two plant supervisors`,
  news: (co) => `${co} announces new distribution facility in the region`,
  filing: (co) => `${co} registers a new entity with the Texas Secretary of State`,
  contract: (co) => `${co} named on a multi-year supply contract with a regional distributor`,
};

const DEAL_SITUATION_NEXT_STEPS = {
  "growth-partner": ["Prepare a short partnership overview for the next call.", "Loop in a colleague who has covered similar growth stories."],
  succession: ["Ask about the family's timeline for stepping back.", "Confirm who else needs to be part of the conversation."],
  "strategic-transition": ["Check in on how the board is framing the transition.", "Offer a relevant precedent once one clears review."],
  other: ["Send a short note recapping the last conversation.", "Check back in a few weeks."],
};

// ---------------------------------------------------------------------------
// 6. Open DB, create schema
// ---------------------------------------------------------------------------
const db = new DatabaseSync(DEMO_DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(SCHEMA);

// Apply the same additive column migrations + unique index a real, migrated
// harness.db would carry (SCHEMA alone predates these columns).
for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
db.exec(UNSUB_TOKEN_INDEX_DDL);

// ---------------------------------------------------------------------------
// 7. Users: copy owner/principal from real db if present, else create from
//    SEED_PASSWORD. Add a third "member" user.
// ---------------------------------------------------------------------------
function hashPassword(pw) {
  // Deterministic salt (derived from the seeded PRNG, not crypto.randomBytes) so
  // the whole demo workspace is byte-identical across runs.
  const salt = Buffer.from(randHex(16), "hex");
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

let ownerRow = null;
let principalRow = null;

if (existsSync(REAL_DB_PATH)) {
  const real = new DatabaseSync(REAL_DB_PATH, { readOnly: true });
  try {
    ownerRow = real.prepare("SELECT * FROM users WHERE email = ?").get("owner@harness.local");
    principalRow = real.prepare("SELECT * FROM users WHERE email = ?").get("principal@harness.local");
  } catch {
    // real db may not have the users table yet; fall through to creating fresh ones.
  } finally {
    real.close();
  }
}

if (!ownerRow || !principalRow) {
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 12) {
    console.error(
      "harness.db not found (or missing the two login users) and SEED_PASSWORD is not set. " +
        "Set SEED_PASSWORD (12+ chars) in the environment to create fresh demo login users."
    );
    process.exit(1);
  }
  const hash = hashPassword(password);
  ownerRow = ownerRow || { id: 1, email: "owner@harness.local", name: FIRM_SENDER_NAME, role: "owner", password_hash: hash };
  principalRow = principalRow || { id: 2, email: "principal@harness.local", name: "Elaine Marsh", role: "principal", password_hash: hash };
}

db.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)").run(
  1,
  "owner@harness.local",
  ownerRow.name,
  "owner",
  ownerRow.password_hash,
  isoDateTime(daysFromToday(-400))
);
db.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)").run(
  2,
  "principal@harness.local",
  principalRow.name,
  "principal",
  principalRow.password_hash,
  isoDateTime(daysFromToday(-400))
);
const memberPasswordHash = hashPassword(process.env.SEED_PASSWORD && process.env.SEED_PASSWORD.length >= 12 ? process.env.SEED_PASSWORD : "demo-workspace-member-pw");
db.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)").run(
  3,
  "member@harness.local",
  "Colby Pruitt",
  "member",
  memberPasswordHash,
  isoDateTime(daysFromToday(-370))
);

// ---------------------------------------------------------------------------
// 8. Companies: ~45 total (owners ~33, referrals 8, institutions 4)
// ---------------------------------------------------------------------------
const usedCompanyNames = new Set();
const companies = []; // {id, name, domain, segment_id, industry, city, state, employees, revenue_band, source, signal_score}

function addCompany({ name, segmentId, industry, source }) {
  const [city, state] = pick(CITIES);
  const employees = randInt(18, 640);
  const revenueBands = ["$5M-$10M", "$10M-$25M", "$25M-$50M", "$50M-$100M", "$100M-$250M"];
  const revenue_band = pick(revenueBands);
  const domain = `${slugify(name)}.example`;
  const signal_score = randFloat(0, 40, 1);
  const notesPool = [
    "Referred in by a regional CPA contact.",
    "Came up in a signal-engine hiring scan.",
    "Met at a regional manufacturing trade event.",
    "Inbound after a colleague's introduction.",
    null,
    null,
  ];
  const id = companies.length + 1;
  companies.push({
    id,
    name,
    domain,
    segment_id: segmentId,
    industry,
    city,
    state,
    employees,
    revenue_band,
    source,
    signal_score,
    notes: pick(notesPool),
  });
  return id;
}

// 33 owners
for (let i = 0; i < 33; i++) {
  const name = makeOwnerCompanyName(usedCompanyNames);
  addCompany({ name, segmentId: "owners", industry: pick(OWNER_INDUSTRIES), source: pick(SOURCES) });
}
// 8 referrals
for (let i = 0; i < 8; i++) {
  const kind = pick(REFERRAL_KINDS);
  const last = pick(PERSON_LAST_NAMES);
  const name = `${last} ${pick(kind.suffixes)}`;
  if (usedCompanyNames.has(name)) continue;
  usedCompanyNames.add(name);
  addCompany({ name, segmentId: "referrals", industry: kind.label, source: pick(SOURCES) });
}
// 4 institutions
for (const name of INSTITUTION_NAMES.slice(0, 4)) {
  usedCompanyNames.add(name);
  addCompany({ name, segmentId: "institutions", industry: "Depository institution", source: pick(SOURCES) });
}

const insCompany = db.prepare(
  `INSERT INTO companies (id, name, domain, segment_id, industry, city, state, employees, revenue_band, source, signal_score, notes, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
for (const c of companies) {
  const created = daysFromToday(-randInt(30, 300));
  insCompany.run(
    c.id, c.name, c.domain, c.segment_id, c.industry, c.city, c.state, c.employees,
    c.revenue_band, c.source, c.signal_score, c.notes, isoDateTime(created), isoDateTime(created)
  );
}

// ---------------------------------------------------------------------------
// 9. Contacts: ~90, with 4 do_not_contact + matching suppression rows
// ---------------------------------------------------------------------------
const contacts = [];
const usedEmails = new Set();
const usedContactNames = new Set();

function makeContact(companyId, companyDomain) {
  let first, last, key;
  do {
    first = pick(PERSON_FIRST_NAMES);
    last = pick(PERSON_LAST_NAMES);
    key = `${first}${last}${companyId}`;
  } while (usedContactNames.has(key));
  usedContactNames.add(key);
  let email = `${first.toLowerCase()}.${last.toLowerCase()}@${companyDomain}`;
  let n = 1;
  while (usedEmails.has(email)) {
    email = `${first.toLowerCase()}.${last.toLowerCase()}${n}@${companyDomain}`;
    n++;
  }
  usedEmails.add(email);
  const id = contacts.length + 1;
  const contact = {
    id,
    company_id: companyId,
    first_name: first,
    last_name: last,
    title: pick(TITLES),
    email,
    email_status: pick(EMAIL_STATUSES),
    phone: `+1-${randInt(200, 999)}-555-${String(randInt(0, 9999)).padStart(4, "0")}`,
    linkedin_url: `https://www.linkedin.example/in/${first.toLowerCase()}-${last.toLowerCase()}-${randInt(100, 999)}`,
    source: pick(SOURCES),
    apollo_id: rand() > 0.5 ? `apollo-${randInt(100000, 999999)}` : null,
    do_not_contact: 0,
  };
  contacts.push(contact);
  return contact;
}

// distribute ~90 contacts across companies, 1-3 each, favoring owners/referrals
let contactBudget = 90;
const contactableCompanies = companies.filter((c) => c.segment_id !== "institutions").concat(companies.filter((c) => c.segment_id === "institutions"));
for (const c of contactableCompanies) {
  if (contactBudget <= 0) break;
  const n = Math.min(contactBudget, randInt(1, 3));
  for (let i = 0; i < n; i++) {
    makeContact(c.id, c.domain);
    contactBudget--;
  }
}
// top off to exactly ~90 if short
while (contactBudget > 0) {
  const c = pick(companies);
  makeContact(c.id, c.domain);
  contactBudget--;
}

// mark 4 do_not_contact
const dncContacts = pickN(contacts, 4);
for (const c of dncContacts) c.do_not_contact = 1;

const insContact = db.prepare(
  `INSERT INTO contacts (id, company_id, first_name, last_name, title, email, email_status, phone, linkedin_url, source, apollo_id, do_not_contact, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
for (const c of contacts) {
  const created = daysFromToday(-randInt(10, 280));
  insContact.run(
    c.id, c.company_id, c.first_name, c.last_name, c.title, c.email, c.email_status,
    c.phone, c.linkedin_url, c.source, c.apollo_id, c.do_not_contact,
    isoDateTime(created), isoDateTime(created)
  );
}

const insSuppression = db.prepare("INSERT INTO suppression (email, reason, created_at) VALUES (?,?,?)");
const SUPPRESSION_REASONS = ["Recipient asked to be removed.", "Hard bounce.", "Marked as spam complaint.", "Do-not-contact flag from prior engagement."];
for (const c of dncContacts) {
  insSuppression.run(c.email, pick(SUPPRESSION_REASONS), isoDateTime(daysFromToday(-randInt(5, 200))));
}

// ---------------------------------------------------------------------------
// 10. Deals: 18, spread across ALL firm dealStages
// ---------------------------------------------------------------------------
const DEAL_STAGES = [
  "Sourced", "Contacted", "In Dialogue", "NDA", "Engaged", "In Market", "LOI", "Closed", "Passed",
];
const dealCompanies = pickN(
  companies.filter((c) => c.segment_id === "owners"),
  18
);
const deals = [];
// Ensure every stage is represented at least once (18 deals, 9 stages -> 2 each).
const stageAssignments = [];
for (const s of DEAL_STAGES) stageAssignments.push(s, s);
for (let i = 0; i < 18; i++) {
  stageAssignments[i] = stageAssignments[i] || pick(DEAL_STAGES);
}

for (let i = 0; i < 18; i++) {
  const company = dealCompanies[i];
  const companyContacts = contacts.filter((c) => c.company_id === company.id);
  const primaryContact = companyContacts.length ? pick(companyContacts) : null;
  const stage = stageAssignments[i];
  const situation = pick(SITUATIONS);
  const id = deals.length + 1;

  let nextStepDue;
  let noActivityRecently = false;
  const bucket = i % 6;
  if (bucket === 0) nextStepDue = daysFromToday(-randInt(2, 9)); // overdue
  else if (bucket === 1) nextStepDue = daysFromToday(0); // due today
  else if (bucket === 2) nextStepDue = daysFromToday(randInt(1, 6)); // this week
  else if (bucket === 3) nextStepDue = daysFromToday(randInt(10, 45)); // later
  else if (bucket === 4) {
    nextStepDue = daysFromToday(randInt(1, 6));
    noActivityRecently = true; // going quiet despite a nominal next step
  } else nextStepDue = null; // no date set

  deals.push({
    id,
    company_id: company.id,
    primary_contact_id: primaryContact ? primaryContact.id : null,
    title: `${company.name} ${situation === "succession" ? "succession planning" : situation === "growth-partner" ? "growth partnership" : situation === "strategic-transition" ? "strategic transition" : "engagement"}`,
    stage,
    situation,
    next_step: pick(DEAL_SITUATION_NEXT_STEPS[situation]),
    next_step_due: nextStepDue ? isoDate(nextStepDue) : null,
    owner_user_id: pick([1, 2]),
    noActivityRecently,
  });
}
// tag the 3 "going quiet" deals explicitly (first 3 with bucket 4, else force 3)
let quietCount = deals.filter((d) => d.noActivityRecently).length;
let qi = 0;
while (quietCount < 3 && qi < deals.length) {
  if (!deals[qi].noActivityRecently) {
    deals[qi].noActivityRecently = true;
    quietCount++;
  }
  qi++;
}

const insDeal = db.prepare(
  `INSERT INTO deals (id, company_id, primary_contact_id, title, stage, situation, next_step, next_step_due, owner_user_id, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`
);
for (const d of deals) {
  const created = daysFromToday(-randInt(15, 260));
  insDeal.run(
    d.id, d.company_id, d.primary_contact_id, d.title, d.stage, d.situation,
    d.next_step, d.next_step_due, d.owner_user_id, isoDateTime(created), isoDateTime(created)
  );
}

// ---------------------------------------------------------------------------
// 11. Tasks: ~25, relative to today
// ---------------------------------------------------------------------------
const TASK_TITLES = [
  "Send follow-up note", "Prep call brief", "Confirm meeting time", "Review latest financials summary",
  "Draft introduction email", "Check in after board meeting", "Update deal notes", "Research recent hiring activity",
  "Schedule quarterly check-in", "Follow up on referral", "Send holiday note", "Review signal-engine flag",
  "Confirm decision-maker list", "Prepare partnership overview", "Log call summary",
];
const insTask = db.prepare(
  `INSERT INTO tasks (id, title, due, done, deal_id, contact_id, created_at) VALUES (?,?,?,?,?,?,?)`
);
let taskId = 1;
const taskBuckets = ["overdue", "today", "this-week", "later", "no-date"];
for (let i = 0; i < 25; i++) {
  const bucket = taskBuckets[i % taskBuckets.length];
  let due = null;
  if (bucket === "overdue") due = isoDate(daysFromToday(-randInt(1, 8)));
  else if (bucket === "today") due = isoDate(daysFromToday(0));
  else if (bucket === "this-week") due = isoDate(daysFromToday(randInt(1, 6)));
  else if (bucket === "later") due = isoDate(daysFromToday(randInt(9, 40)));
  // "no-date" leaves due null

  const attachToDeal = rand() > 0.35;
  const deal = attachToDeal ? pick(deals) : null;
  const contact = !deal && rand() > 0.5 ? pick(contacts) : null;
  const done = i > 20 && rand() > 0.4 ? 1 : 0; // a few marked done, near the end
  const created = daysFromToday(-randInt(1, 60));
  insTask.run(
    taskId++,
    pick(TASK_TITLES),
    due,
    done,
    deal ? deal.id : null,
    contact ? contact.id : null,
    isoDateTime(created)
  );
}

// ---------------------------------------------------------------------------
// 12. Activities: ~120 over the last 90 days, believable timelines
// ---------------------------------------------------------------------------
const ACTIVITY_KINDS = ["note", "call", "email-out", "email-in", "stage-change", "signal", "import"];
const insActivity = db.prepare(
  `INSERT INTO activities (id, kind, body, company_id, contact_id, deal_id, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)`
);
let activityId = 1;
const quietDealIds = new Set(deals.filter((d) => d.noActivityRecently).map((d) => d.id));

for (let i = 0; i < 120; i++) {
  const company = pick(companies);
  const companyContacts = contacts.filter((c) => c.company_id === company.id);
  const contact = companyContacts.length && rand() > 0.3 ? pick(companyContacts) : null;
  const companyDeals = deals.filter((d) => d.company_id === company.id);
  const deal = companyDeals.length && rand() > 0.4 ? pick(companyDeals) : null;
  const kind = pick(ACTIVITY_KINDS);

  // keep "going quiet" deals' activity older than 25 days
  let createdOffset;
  if (deal && quietDealIds.has(deal.id)) {
    createdOffset = -randInt(26, 89);
  } else {
    createdOffset = -randInt(0, 89);
  }
  const created = daysFromToday(createdOffset);

  let body;
  if (kind === "stage-change") body = `Stage moved to ${pick(DEAL_STAGES)}.`;
  else if (kind === "signal") body = `Signal-engine flagged new activity for ${company.name}.`;
  else if (kind === "import") body = `Contact record imported from ${pick(["Apollo", "a referral list", "a trade show scan"])}.`;
  else if (kind === "email-out") body = `Sent a short note recapping the last conversation. ${pick(NOTE_NEXT_STEPS)}`;
  else if (kind === "email-in") body = `Received a reply confirming interest in staying in touch.`;
  else body = makeActivityNote();

  insActivity.run(
    activityId++,
    kind,
    body,
    company.id,
    contact ? contact.id : null,
    deal ? deal.id : null,
    pick([1, 2, 3]),
    isoDateTime(created)
  );
}

// ---------------------------------------------------------------------------
// 13. Signals: ~70 over the last 60 days
// ---------------------------------------------------------------------------
const insSignal = db.prepare(
  `INSERT INTO signals (id, company_id, kind, title, url, observed_at, weight, created_at) VALUES (?,?,?,?,?,?,?,?)`
);
let signalId = 1;
for (let i = 0; i < 70; i++) {
  const company = pick(companies);
  const kind = pick(SIGNAL_KINDS);
  const title = SIGNAL_TEMPLATES[kind](company.name);
  const observed = daysFromToday(-randInt(0, 60));
  const url = `https://news.example/${randInt(2024, 2026)}/${String(randInt(1, 12)).padStart(2, "0")}/${slugify(company.name)}-${kind}`;
  insSignal.run(
    signalId++,
    company.id,
    kind,
    title,
    url,
    isoDate(observed),
    randFloat(0.5, 3, 1),
    isoDateTime(observed)
  );
}

// ---------------------------------------------------------------------------
// 14. Templates: 2 approved, 1 pending, 1 draft, 1 rejected
// ---------------------------------------------------------------------------
const templateDefs = [
  {
    name: "Owner intro, growth partner",
    segment_id: "owners",
    subject: "Quick note for {{company_name}}",
    body:
      "Hi {{first_name}},\n\n" +
      "I work with founder-owned companies across Texas as they think through their next chapter. Your name came up recently, and I wanted to introduce myself.\n\n" +
      "If it would be useful to compare notes on how other owners in your industry have approached growth, I would welcome a short call.\n\n" +
      `Warm regards,\n${FIRM_SENDER_NAME}\n${FIRM_SENDER_TITLE}\nHarbor Point Advisors`,
    status: "approved",
  },
  {
    name: "Referral source check-in",
    segment_id: "referrals",
    subject: "Staying in touch, {{first_name}}",
    body:
      "Hi {{first_name}},\n\n" +
      "It has been a while since we last spoke. I wanted to check in and see how things are going on your end.\n\n" +
      "If a client of yours is ever weighing a transition, I am glad to be a resource, no obligation either way.\n\n" +
      `Best,\n${FIRM_SENDER_NAME}\n${FIRM_SENDER_TITLE}\nHarbor Point Advisors`,
    status: "approved",
  },
  {
    name: "Institution partnership note",
    segment_id: "institutions",
    subject: "A note from Harbor Point",
    body:
      "Hi {{first_name}},\n\n" +
      "I wanted to reach out directly given the overlap between our work and {{company_name}}'s footprint in the region.\n\n" +
      "Open to a short conversation when timing allows.\n\n" +
      `Best,\n${FIRM_SENDER_NAME}`,
    status: "pending",
  },
  {
    name: "Owner succession opener (draft)",
    segment_id: "owners",
    subject: "Thinking ahead for {{company_name}}",
    body:
      "Hi {{first_name}},\n\n" +
      "Many owners we work with start thinking about the next chapter well before they act on it. If that describes where you are, I would welcome the chance to listen.\n\n" +
      `Best,\n${FIRM_SENDER_NAME}`,
    status: "draft",
  },
  {
    name: "Owner cold opener (rejected)",
    segment_id: "owners",
    subject: "Sell {{company_name}} for top dollar",
    body:
      "Hi {{first_name}},\n\n" +
      "We can get you a great price for {{company_name}} quickly and easily. Let's talk.\n\n" +
      FIRM_SENDER_NAME.split(" ")[0],
    status: "rejected",
    review_note: "Contains a valuation promise and implies ease. Rewrite in a restrained voice before resubmitting.",
  },
];

const insTemplate = db.prepare(
  `INSERT INTO templates (id, name, segment_id, subject, body, allowed_merge_fields, content_hash, status, approved_by, approved_at, review_note, created_by, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);

const templates = [];
templateDefs.forEach((t, idx) => {
  const id = idx + 1;
  const allowedFields = ["first_name", "company_name"];
  // Voice-gate only the templates meant to be sendable copy (not the intentionally rejected one).
  if (t.status !== "rejected") {
    assertVoiceClean(t.name, t.subject);
    assertVoiceClean(t.name, t.body);
  }
  const hash = contentHash(t.subject, t.body, allowedFields);
  const created = daysFromToday(-randInt(20, 120));
  const approvedAt = t.status === "approved" ? isoDateTime(daysFromToday(-randInt(5, 90))) : null;
  insTemplate.run(
    id,
    t.name,
    t.segment_id,
    t.subject,
    t.body,
    JSON.stringify(allowedFields),
    hash,
    t.status,
    t.status === "approved" ? 2 : null,
    approvedAt,
    t.review_note || null,
    1,
    isoDateTime(created),
    isoDateTime(created)
  );
  templates.push({ id, ...t, allowedFields, hash });
});

// ---------------------------------------------------------------------------
// 15. Mailboxes: 8, warmup staggered 6 weeks ago to not started, one paused
// ---------------------------------------------------------------------------
const insMailbox = db.prepare(
  `INSERT INTO mailboxes (id, address, provider, warmup_started, paused, created_at) VALUES (?,?,?,?,?,?)`
);
const mailboxDomains = ["csc-outreach.example", "csc-mail.example"];
const warmupOffsets = [-42, -35, -28, -21, -14, -7, null, null]; // weeks staggered, last two not started
for (let i = 0; i < 8; i++) {
  const address = `banker${i + 1}@${mailboxDomains[i % mailboxDomains.length]}`;
  const warmup = warmupOffsets[i] !== null ? isoDate(daysFromToday(warmupOffsets[i])) : null;
  const paused = i === 5 ? 1 : 0; // one paused
  insMailbox.run(i + 1, address, "apollo", warmup, paused, isoDateTime(daysFromToday(-60)));
}

// ---------------------------------------------------------------------------
// 16. Outbound messages: ~30, mixed states, content matches template+merge
// ---------------------------------------------------------------------------
const approvedTemplates = templates.filter((t) => t.status === "approved");
const sendableContacts = contacts.filter((c) => !c.do_not_contact);

function renderForMerge(tpl, merge) {
  function fill(text) {
    return text.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, (_full, field) => merge[field] ?? "");
  }
  return { subject: fill(tpl.subject), body: fill(tpl.body) };
}

const insOutbound = db.prepare(
  `INSERT INTO outbound_messages (id, contact_id, template_id, template_hash, merge_json, rendered_subject, rendered_body, lint_json, status, mailbox, scheduled_for, sent_at, provider_id, error, created_at, unsubscribe_token, rendered_footer)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);

const HOLD_REASONS = [
  "Mailbox daily cap reached for today.",
  "Recipient domain has no valid MX record.",
  "Suppression list match found at send time.",
  "Template hash mismatch, approval voided since queue time.",
];

let msgId = 1;
const outboundCount = 30;
const chosenContacts = pickN(sendableContacts, Math.min(outboundCount, sendableContacts.length));
for (let i = 0; i < outboundCount; i++) {
  const contact = chosenContacts[i % chosenContacts.length];
  const company = companies.find((c) => c.id === contact.company_id);
  const tpl = pick(approvedTemplates);
  const merge = { first_name: contact.first_name, company_name: company ? company.name : "" };
  const rendered = renderForMerge(tpl, merge);

  let status, mailbox, scheduledFor, sentAt, providerId, error;
  const bucket = i % 5;
  if (bucket === 0) {
    status = "queued";
    mailbox = `banker${randInt(1, 4)}@${pick(mailboxDomains)}`;
    scheduledFor = isoDate(daysFromToday(randInt(1, 7)));
    sentAt = null;
    providerId = null;
    error = null;
  } else if (bucket === 1) {
    status = "held";
    mailbox = `banker${randInt(1, 4)}@${pick(mailboxDomains)}`;
    scheduledFor = isoDate(daysFromToday(randInt(0, 3)));
    sentAt = null;
    providerId = null;
    error = pick(HOLD_REASONS);
  } else if (bucket === 2 || bucket === 3) {
    status = "sent";
    mailbox = `banker${randInt(1, 6)}@${pick(mailboxDomains)}`;
    const sentDate = daysFromToday(-randInt(1, 45));
    scheduledFor = isoDate(sentDate);
    sentAt = isoDateTime(sentDate);
    providerId = `dryrun-${randHex(6)}`;
    error = null;
  } else {
    status = "cancelled";
    mailbox = null;
    scheduledFor = isoDate(daysFromToday(randInt(-5, 5)));
    sentAt = null;
    providerId = null;
    error = "Cancelled before send, deal stage changed.";
  }

  const unsubscribeToken = makeUnsubscribeToken();
  const renderedFooter = renderedFooterFor(unsubscribeToken);

  insOutbound.run(
    msgId,
    contact.id,
    tpl.id,
    tpl.hash,
    JSON.stringify(merge),
    rendered.subject,
    rendered.body,
    JSON.stringify([]),
    status,
    mailbox,
    scheduledFor,
    sentAt,
    providerId,
    error,
    isoDateTime(daysFromToday(-randInt(1, 50))),
    unsubscribeToken,
    renderedFooter
  );
  msgId++;
}
// Force exactly 2 cancelled per the brief (top up/trim if the round-robin under/overshot).
{
  const cancelledIds = db.prepare("SELECT id FROM outbound_messages WHERE status = 'cancelled'").all().map((r) => r.id);
  if (cancelledIds.length > 2) {
    const extra = cancelledIds.slice(2);
    for (const id of extra) {
      db.prepare("UPDATE outbound_messages SET status = 'queued', error = NULL, sent_at = NULL, provider_id = NULL WHERE id = ?").run(id);
    }
  } else if (cancelledIds.length < 2) {
    const candidates = db.prepare("SELECT id FROM outbound_messages WHERE status != 'cancelled' LIMIT ?").all(2 - cancelledIds.length);
    for (const row of candidates) {
      db.prepare("UPDATE outbound_messages SET status = 'cancelled', error = 'Cancelled before send, deal stage changed.', sent_at = NULL, provider_id = NULL WHERE id = ?").run(row.id);
    }
  }
}

// ---------------------------------------------------------------------------
// 16b. Contacts: mark apollo-sourced ones enriched.
// ---------------------------------------------------------------------------
{
  const upd = db.prepare("UPDATE contacts SET enriched_at = ? WHERE id = ?");
  for (const c of contacts) {
    if (c.apollo_id) {
      upd.run(isoDateTime(daysFromToday(-randInt(3, 200))), c.id);
    }
  }
}

// ---------------------------------------------------------------------------
// 16c. Inbound replies: ~9 over the last 3 weeks, tied to "sent" demo
// messages. Applies the same real effects app/lib/replies/sync.ts's
// ingestReply() applies, so the demo workspace looks like a genuinely synced
// inbox rather than static rows.
// ---------------------------------------------------------------------------
const sentMessageRows = db
  .prepare(
    `SELECT om.id, om.contact_id, c.first_name, c.last_name, comp.name AS company_name
     FROM outbound_messages om
     JOIN contacts c ON c.id = om.contact_id
     LEFT JOIN companies comp ON comp.id = c.company_id
     WHERE om.status = 'sent'`
  )
  .all();

if (sentMessageRows.length < 9) {
  console.error(`Expected at least 9 "sent" outbound messages to attach inbound replies to, found ${sentMessageRows.length}.`);
  process.exit(1);
}
const replySourceMessages = pickN(sentMessageRows, 9);

const insReply = db.prepare(
  `INSERT INTO inbound_replies (provider_id, message_id, contact_id, from_email, subject, snippet, kind, handled, received_at, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);
const updMessageRepliedAt = db.prepare("UPDATE outbound_messages SET replied_at = ? WHERE id = ?");
const updContactBounced = db.prepare("UPDATE contacts SET email_status = 'no-mx' WHERE id = ?");
const updContactUnsubscribed = db.prepare("UPDATE contacts SET do_not_contact = 1, unsubscribed_at = ? WHERE id = ?");
const insSuppressionForReply = db.prepare("INSERT OR IGNORE INTO suppression (email, reason, created_at) VALUES (?,?,?)");
const cancelQueuedForContact = db.prepare(
  "UPDATE outbound_messages SET status = 'cancelled', error = 'Cancelled after contact replied.' WHERE contact_id = ? AND status IN ('queued','held')"
);
let replyTaskId = taskId; // continue the task id sequence started in section 11

function contactFullName(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ");
  return name || "this contact";
}

// 5 kind "reply" (2 already handled by the banker, 3 still open and get a
// follow-up task, mirroring ingestReply's real effect for an open reply).
const REPLY_SUBJECTS_HANDLED = [
  { subject: "Re: Quick note for {{company}}", snippet: "Thanks for reaching out. Happy to grab fifteen minutes next week if that works on your end." },
  { subject: "Re: Staying in touch, {{first}}", snippet: "Good to hear from you. Nothing new to report right now, but I will keep you posted." },
];
const REPLY_SUBJECTS_OPEN = [
  { subject: "Re: A note from Harbor Point", snippet: "Appreciate the note. Let me check my calendar and get back to you this week." },
  { subject: "Following up on your email", snippet: "This caught me at a busy time, but I am open to a short call once things settle down." },
  { subject: "Re: Quick note for {{company}}", snippet: "Interesting timing. Can you send a couple of times that work for a quick call." },
];
const AUTO_REPLY_SUBJECTS = [
  { subject: "Automatic reply: Out of office", snippet: "I am out of the office this week with limited access to email. I will respond when I return." },
  { subject: "Out of office", snippet: "Thanks for your message. I am traveling and will reply as soon as I am back at my desk." },
];
const BOUNCE_SUBJECT = { subject: "Delivery Status Notification (Failure)", snippet: "The following message could not be delivered. The recipient's mail server rejected the address." };
const UNSUBSCRIBE_SUBJECT = { subject: "Please remove me from your list", snippet: "Please take me off this list and do not write again." };

let ri = 0;
function nextReplySource() {
  return replySourceMessages[ri++];
}

function fillNames(text, msg) {
  return text.replace("{{company}}", msg.company_name || "your company").replace("{{first}}", msg.first_name || "there");
}

// 2 handled replies
for (const tpl of REPLY_SUBJECTS_HANDLED) {
  const msg = nextReplySource();
  const receivedAt = daysFromToday(-randInt(1, 21));
  const providerId = `demo-reply-${randHex(6)}`;
  insReply.run(
    providerId,
    msg.id,
    msg.contact_id,
    `${(msg.first_name || "contact").toLowerCase()}.${(msg.last_name || "reply").toLowerCase()}@reply.example`,
    fillNames(tpl.subject, msg),
    fillNames(tpl.snippet, msg),
    "reply",
    1,
    isoDateTime(receivedAt),
    isoDateTime(receivedAt)
  );
  updMessageRepliedAt.run(isoDateTime(receivedAt), msg.id);
  db.prepare(`INSERT INTO activities (kind, body, contact_id, created_at) VALUES ('email-in', ?, ?, ?)`).run(
    `Reply received: ${fillNames(tpl.subject, msg)}`,
    msg.contact_id,
    isoDateTime(receivedAt)
  );
  cancelQueuedForContact.run(msg.contact_id);
}

// 3 open (unhandled) replies, each gets a follow-up task like ingestReply does
for (const tpl of REPLY_SUBJECTS_OPEN) {
  const msg = nextReplySource();
  const receivedAt = daysFromToday(-randInt(1, 21));
  const providerId = `demo-reply-${randHex(6)}`;
  insReply.run(
    providerId,
    msg.id,
    msg.contact_id,
    `${(msg.first_name || "contact").toLowerCase()}.${(msg.last_name || "reply").toLowerCase()}@reply.example`,
    fillNames(tpl.subject, msg),
    fillNames(tpl.snippet, msg),
    "reply",
    0,
    isoDateTime(receivedAt),
    isoDateTime(receivedAt)
  );
  updMessageRepliedAt.run(isoDateTime(receivedAt), msg.id);
  db.prepare(`INSERT INTO activities (kind, body, contact_id, created_at) VALUES ('email-in', ?, ?, ?)`).run(
    `Reply received: ${fillNames(tpl.subject, msg)}`,
    msg.contact_id,
    isoDateTime(receivedAt)
  );
  cancelQueuedForContact.run(msg.contact_id);
  db.prepare(`INSERT INTO tasks (id, title, due, contact_id, created_at) VALUES (?,?,?,?,?)`).run(
    replyTaskId++,
    `Reply to ${contactFullName(msg)}`,
    isoDate(daysFromToday(0)),
    msg.contact_id,
    isoDateTime(receivedAt)
  );
}

// 2 auto-replies: recorded only, no further effect
for (const tpl of AUTO_REPLY_SUBJECTS) {
  const msg = nextReplySource();
  const receivedAt = daysFromToday(-randInt(1, 21));
  const providerId = `demo-reply-${randHex(6)}`;
  insReply.run(
    providerId,
    msg.id,
    msg.contact_id,
    `${(msg.first_name || "contact").toLowerCase()}.${(msg.last_name || "reply").toLowerCase()}@reply.example`,
    tpl.subject,
    tpl.snippet,
    "auto-reply",
    0,
    isoDateTime(receivedAt),
    isoDateTime(receivedAt)
  );
}

// 1 bounce
{
  const msg = nextReplySource();
  const receivedAt = daysFromToday(-randInt(1, 21));
  const providerId = `demo-reply-${randHex(6)}`;
  insReply.run(
    providerId,
    msg.id,
    msg.contact_id,
    "mailer-daemon@mail.example",
    BOUNCE_SUBJECT.subject,
    BOUNCE_SUBJECT.snippet,
    "bounce",
    0,
    isoDateTime(receivedAt),
    isoDateTime(receivedAt)
  );
  updContactBounced.run(msg.contact_id);
  cancelQueuedForContact.run(msg.contact_id);
}

// 1 unsubscribe
{
  const msg = nextReplySource();
  const receivedAt = daysFromToday(-randInt(1, 21));
  const providerId = `demo-reply-${randHex(6)}`;
  const fromEmail = `${(msg.first_name || "contact").toLowerCase()}.${(msg.last_name || "unsub").toLowerCase()}@reply.example`;
  insReply.run(
    providerId,
    msg.id,
    msg.contact_id,
    fromEmail,
    UNSUBSCRIBE_SUBJECT.subject,
    UNSUBSCRIBE_SUBJECT.snippet,
    "unsubscribe",
    0,
    isoDateTime(receivedAt),
    isoDateTime(receivedAt)
  );
  insSuppressionForReply.run(fromEmail, "unsubscribe", isoDateTime(receivedAt));
  updContactUnsubscribed.run(isoDateTime(receivedAt), msg.contact_id);
  cancelQueuedForContact.run(msg.contact_id);
}

// ---------------------------------------------------------------------------
// 17. Audit log: ~60 rows telling the story
// ---------------------------------------------------------------------------
const insAudit = db.prepare(
  `INSERT INTO audit_log (id, actor_user_id, actor_label, action, entity, entity_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?,?)`
);
let auditId = 1;
function addAudit({ actorUserId = null, actorLabel = null, action, entity = null, entityId = null, detail = {}, created }) {
  insAudit.run(auditId, actorUserId, actorLabel, action, entity, entityId, JSON.stringify(detail), isoDateTime(created));
  auditId++;
}

// logins, spread over the last 30 days
for (let i = 0; i < 14; i++) {
  addAudit({
    actorUserId: pick([1, 2, 3]),
    action: "login",
    created: daysFromToday(-randInt(0, 30)),
  });
}
// imports
for (let i = 0; i < 6; i++) {
  addAudit({
    actorUserId: pick([1, 2]),
    action: "import",
    entity: "companies",
    detail: { source: pick(["apollo", "csv"]), rows: randInt(5, 40) },
    created: daysFromToday(-randInt(5, 200)),
  });
}
// template lifecycle events matching the seeded templates
for (const t of templates) {
  addAudit({
    actorUserId: 1,
    action: "template.submit",
    entity: "templates",
    entityId: t.id,
    detail: { name: t.name },
    created: daysFromToday(-randInt(15, 110)),
  });
  if (t.status === "approved") {
    addAudit({
      actorUserId: 2,
      action: "template.approve",
      entity: "templates",
      entityId: t.id,
      detail: { name: t.name, content_hash: t.hash },
      created: daysFromToday(-randInt(5, 90)),
    });
  } else if (t.status === "rejected") {
    addAudit({
      actorUserId: 2,
      action: "template.reject",
      entity: "templates",
      entityId: t.id,
      detail: { name: t.name, review_note: t.review_note },
      created: daysFromToday(-randInt(5, 90)),
    });
  }
}
// message queue / block events for a sample of outbound rows
const outboundRows = db.prepare("SELECT id, status, mailbox, error FROM outbound_messages").all();
for (const row of outboundRows) {
  addAudit({
    actorUserId: pick([1, 2]),
    action: "message.queue",
    entity: "outbound_messages",
    entityId: row.id,
    detail: { mailbox: row.mailbox },
    created: daysFromToday(-randInt(1, 45)),
  });
  if (row.status === "held") {
    addAudit({
      actorLabel: "send-pipe",
      action: "message.block",
      entity: "outbound_messages",
      entityId: row.id,
      detail: { reason: row.error },
      created: daysFromToday(-randInt(0, 3)),
    });
  }
}
// signal-engine run, dated 3 days ago
addAudit({
  actorLabel: "signal-engine",
  action: "signals.run",
  detail: { companies_scanned: companies.length, signals_found: 70 },
  created: daysFromToday(-3),
});

// Trim/pad audit_log to land near 60 rows by adding a few more logins if short.
{
  const count = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;
  let extra = 60 - count;
  while (extra > 0) {
    addAudit({ actorUserId: pick([1, 2, 3]), action: "login", created: daysFromToday(-randInt(0, 60)) });
    extra--;
  }
}

// ---------------------------------------------------------------------------
// 17b. Profile facts: sourced owner/business facts for a couple of showcase
// companies, so the banker profile page (app/lib/profile.ts) has something
// to render besides "Not in public sources" out of the box. Fictional, but
// shaped exactly like what scrapers/profile_enrich.py would have written.
// ---------------------------------------------------------------------------
function hostOf_(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
const insFact = db.prepare(
  `INSERT INTO profile_facts (entity, entity_id, field, value, value_key, source_url, source_label, confidence, match_basis, note, observed_at, fetched_at)
   VALUES ('company',?,?,?,?,?,?,?,?,?,?,?)`
);
const factFetchedAt = isoDateTime(daysFromToday(-6));
function addProfileFact(companyId, field, value, opts = {}) {
  insFact.run(
    companyId,
    field,
    value,
    opts.valueKey ?? "",
    opts.sourceUrl ?? `https://${companies.find((c) => c.id === companyId)?.domain}/about`,
    opts.sourceLabel ?? null,
    opts.confidence ?? "confirmed",
    opts.matchBasis ?? null,
    opts.note ?? null,
    opts.observedAt ?? null,
    factFetchedAt
  );
}

function companyByName(name) {
  const c = companies.find((x) => x.name === name);
  if (!c) throw new Error(`seed-demo profile facts: no company named "${name}"`);
  return c;
}

// Cottonwood Fabrication: the company behind the Foster Ashworth contact
// profile screenshot in docs/screenshots. Give it a full owner + business
// picture, sourced the way the real scrapers would.
{
  const co = companyByName("Cottonwood Fabrication");
  // Its industry label is randomly assigned from OWNER_INDUSTRIES above and can
  // land on something unrelated (e.g. "Commercial roofing supply"). Pin it to
  // match the steel-fabrication profile facts below so the two never disagree.
  co.industry = "Sheet metal fabrication";
  db.prepare("UPDATE companies SET industry = ? WHERE id = ?").run(co.industry, co.id);
  const site = `https://${co.domain}`;
  const foster = contacts.find((c) => c.company_id === co.id && c.last_name === "Ashworth");
  addProfileFact(co.id, "owner_name", foster ? `${foster.first_name} ${foster.last_name}` : "Foster Ashworth", {
    sourceUrl: `${site}/about`,
    sourceLabel: hostOf_(site),
  });
  addProfileFact(co.id, "owner_title", "President", { sourceUrl: `${site}/about`, sourceLabel: hostOf_(site) });
  addProfileFact(co.id, "owner_since", "2011", {
    sourceUrl: `${site}/about`,
    sourceLabel: hostOf_(site),
    note: "Bought into the business as a minority partner in 2011, took full ownership in 2017.",
  });
  addProfileFact(co.id, "owner_bio", "Started in outside sales before buying into the business; now sole owner and day-to-day operator.", {
    sourceUrl: `${site}/about`,
    sourceLabel: hostOf_(site),
  });
  addProfileFact(co.id, "owner_linkedin", foster?.linkedin_url || "https://www.linkedin.example/in/foster-ashworth-853", {
    sourceUrl: foster?.linkedin_url || "https://www.linkedin.example/in/foster-ashworth-853",
    sourceLabel: "linkedin.example",
  });
  addProfileFact(co.id, "owner_other_roles", "Board member, Wichita Falls Chamber of Commerce", {
    valueKey: "chamber",
    sourceUrl: "https://wichitafallschamber.example/board",
    sourceLabel: "wichitafallschamber.example",
  });
  addProfileFact(co.id, "owner_press", "Named Manufacturer of the Year, Wichita Falls Business Journal (2023)", {
    valueKey: "wfbj-2023",
    sourceUrl: "https://wichitafallsbusinessjournal.example/2023/manufacturer-of-the-year",
    sourceLabel: "wichitafallsbusinessjournal.example",
    observedAt: isoDate(new Date(2023, 10, 14)),
  });

  addProfileFact(co.id, "legal_name", "Cottonwood Fabrication, LLC", { sourceUrl: `${site}/legal`, sourceLabel: hostOf_(site) });
  addProfileFact(co.id, "summary", "Custom structural steel fabrication for commercial and light-industrial contractors across North Texas.", {
    sourceUrl: `${site}/about`,
    sourceLabel: hostOf_(site),
  });
  addProfileFact(co.id, "naics", "332312 - Fabricated Structural Metal Manufacturing", { sourceUrl: `${site}/about`, sourceLabel: hostOf_(site) });
  addProfileFact(co.id, "founded_year", "1998", { sourceUrl: `${site}/about`, sourceLabel: hostOf_(site) });
  addProfileFact(co.id, "formation_date", "03/1998", {
    sourceUrl: "https://www.sos.state.tx.example/filings/cottonwood-fabrication",
    sourceLabel: "Texas SOS",
  });
  addProfileFact(co.id, "entity_type", "Domestic limited liability company", {
    sourceUrl: "https://www.sos.state.tx.example/filings/cottonwood-fabrication",
    sourceLabel: "Texas SOS",
  });
  addProfileFact(co.id, "sos_file_number", "0198445210", {
    sourceUrl: "https://www.sos.state.tx.example/filings/cottonwood-fabrication",
    sourceLabel: "Texas SOS",
  });
  addProfileFact(co.id, "hq_address", `4410 Industrial Loop, Wichita Falls, TX`, { sourceUrl: `${site}/contact`, sourceLabel: hostOf_(site) });
  addProfileFact(co.id, "ownership_type", "family-owned", { sourceUrl: `${site}/about`, sourceLabel: hostOf_(site) });
  addProfileFact(co.id, "family_owned_since", "2011", { sourceUrl: `${site}/about`, sourceLabel: hostOf_(site) });
  addProfileFact(co.id, "end_markets", "Commercial general contractors", { valueKey: "gc", sourceUrl: `${site}/work`, sourceLabel: hostOf_(site) });
  addProfileFact(co.id, "end_markets", "Light-industrial developers", { valueKey: "industrial", sourceUrl: `${site}/work`, sourceLabel: hostOf_(site) });
  addProfileFact(co.id, "certifications", "AISC certified fabricator", {
    valueKey: "aisc",
    sourceUrl: `${site}/certifications`,
    sourceLabel: hostOf_(site),
  });
  addProfileFact(co.id, "company_linkedin", `https://www.linkedin.example/company/cottonwood-fabrication`, {
    sourceUrl: `https://www.linkedin.example/company/cottonwood-fabrication`,
    sourceLabel: "linkedin.example",
  });
  addProfileFact(co.id, "leaders", "Priya Nakamura | Shop Foreman", {
    valueKey: "leader-1",
    sourceUrl: `${site}/about`,
    sourceLabel: hostOf_(site),
    confidence: "unconfirmed",
  });
}

// ---------------------------------------------------------------------------
// 17c. P1 deal economics, deal teams and touch cadence (fictional figures).
// Deterministic, no PRNG draws, so every earlier section stays byte-identical.
// ---------------------------------------------------------------------------
{
  const ECON_STAGES = new Set(["NDA", "Engaged", "In Market", "LOI", "Closed"]);
  const updEcon = db.prepare(
    `UPDATE deals SET ebitda = ?, enterprise_value = ?, retainer = ?, success_fee_pct = ?, probability = ?, expected_close = ?, fee_terms = ? WHERE id = ?`
  );
  const ebitdas = [3_200_000, 4_800_000, 6_500_000, 9_100_000, 5_400_000, 12_000_000, 7_700_000, 3_900_000, 14_500_000, 8_300_000];
  const multiples = [6.5, 7, 8, 8.5, 7.5, 9, 6, 7.25, 10, 8];
  let n = 0;
  for (const d of deals) {
    if (!ECON_STAGES.has(d.stage)) continue;
    const ebitda = ebitdas[n % ebitdas.length];
    const ev = Math.round(ebitda * multiples[n % multiples.length]);
    const retainer = [50_000, 75_000, 60_000, 100_000][n % 4];
    const pct = [3, 2.75, 3.5, 2.5][n % 4];
    const prob = n % 3 === 0 ? null : [35, 55, 70][n % 3]; // some deals use the stage default
    const close = d.stage === "Closed" ? isoDate(daysFromToday(-20 - n * 9)) : isoDate(daysFromToday(35 + n * 28));
    updEcon.run(ebitda, ev, retainer, pct, prob, close, "Retainer credited against the success fee. 12-month tail.", d.id);
    n++;
  }
  // Deal team: the owner leads the later-stage deals, the principal covers, the analyst executes.
  const insTeam = db.prepare("INSERT OR IGNORE INTO deal_team (deal_id, user_id, role, added_at) VALUES (?,?,?,?)");
  for (const d of deals) {
    if (!ECON_STAGES.has(d.stage)) continue;
    insTeam.run(d.id, 1, "lead", isoDateTime(daysFromToday(-30)));
    insTeam.run(d.id, 2, "coverage", isoDateTime(daysFromToday(-30)));
    insTeam.run(d.id, 3, "analyst", isoDateTime(daysFromToday(-25)));
  }
  // Touch cadence: referral-source contacts every 60 days, a few owners monthly.
  const referralContacts = db
    .prepare("SELECT c.id FROM contacts c JOIN companies co ON co.id = c.company_id WHERE co.segment_id = 'referrals' AND c.do_not_contact = 0 ORDER BY c.id LIMIT 6")
    .all();
  const ownerContacts = db
    .prepare("SELECT c.id FROM contacts c JOIN companies co ON co.id = c.company_id WHERE co.segment_id = 'owners' AND c.do_not_contact = 0 ORDER BY c.id LIMIT 4")
    .all();
  const setCadence = db.prepare("UPDATE contacts SET touch_every_days = ? WHERE id = ?");
  const insTouch = db.prepare("INSERT INTO activities (kind, body, contact_id, company_id, user_id, created_at) VALUES ('call', ?, ?, (SELECT company_id FROM contacts WHERE id = ?), 1, ?)");
  referralContacts.forEach((c, i) => {
    setCadence.run(60, c.id);
    // Half are overdue (last call 70-100 days ago), half were called recently.
    const ago = i % 2 === 0 ? 70 + i * 10 : 12 + i * 3;
    insTouch.run("Caught up on who in their book is thinking about a sale.", c.id, c.id, isoDateTime(daysFromToday(-ago)));
  });
  ownerContacts.forEach((c, i) => {
    setCadence.run(30, c.id);
    if (i % 2 === 0) insTouch.run("Quick check-in call.", c.id, c.id, isoDateTime(daysFromToday(-(40 + i * 5))));
  });
}

// ---------------------------------------------------------------------------
// 17d. P2 buyer logs: fictional PE firms, strategics and family offices shown
// three live mandates, with milestone dates, IOIs, an LOI, declines with
// reasons, and buyers shown more than one deal (cross-deal memory).
// Deterministic, no PRNG draws.
// ---------------------------------------------------------------------------
{
  const BUYERS = [
    ["Red Oak Capital Partners", "redoakcapital.example", "pe", 5_000_000, 40_000_000, 3_000_000, 12_000_000, "Platform and add-on deals in industrial services across Texas and the Southwest."],
    ["Trinity Ridge Equity", "trinityridge.example", "pe", 10_000_000, 75_000_000, 4_000_000, 20_000_000, "Founder transitions in specialty manufacturing. Keeps management and rolls equity."],
    ["Pecan Street Capital", "pecanstreet.example", "pe", 3_000_000, 25_000_000, 2_000_000, 8_000_000, "Lower middle market buyouts, first institutional capital."],
    ["Blue Mesa Partners", "bluemesa.example", "pe", 15_000_000, 120_000_000, 6_000_000, 30_000_000, "Distribution and logistics roll-ups."],
    ["Caprock Growth Fund", "caprockgrowth.example", "pe", 5_000_000, 50_000_000, 3_000_000, 15_000_000, "Minority and majority growth equity for owner-led businesses."],
    ["Anchor Point Equity", "anchorpoint.example", "pe", 8_000_000, 60_000_000, 4_000_000, 18_000_000, "Add-ons for its coatings and process platform."],
    ["Gulfline Industrial Group", "gulfline.example", "strategic", null, null, 3_000_000, 25_000_000, "Strategic acquirer adding fabrication capacity along the Gulf Coast."],
    ["Hollister Supply Co", "hollistersupply.example", "strategic", null, null, 2_000_000, 12_000_000, "Regional distributor buying adjacent product lines."],
    ["Keystone Fabrication Holdings", "keystonefab.example", "strategic", null, null, 4_000_000, 30_000_000, "Consolidating contract manufacturers in the central US."],
    ["Summit Process Industries", "summitprocess.example", "strategic", null, null, 5_000_000, 40_000_000, "Process equipment maker looking for service revenue."],
    ["Whitlock Family Office", "whitlockfo.example", "family-office", 5_000_000, 30_000_000, 2_000_000, 10_000_000, "Long-hold family capital, no fixed exit date."],
    ["Marrow Family Holdings", "marrowholdings.example", "family-office", 3_000_000, 20_000_000, 2_000_000, 8_000_000, "Buys and holds Texas businesses with a second-generation question."],
  ];
  const insCo = db.prepare("INSERT INTO companies (name, domain, segment_id, industry, city, state, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  const insProfile = db.prepare(
    "INSERT INTO buyer_profiles (company_id, buyer_type, check_size_low, check_size_high, ebitda_fit_low, ebitda_fit_high, thesis) VALUES (?,?,?,?,?,?,?)"
  );
  const buyerIds = BUYERS.map(([name, domain, type, cl, ch, el, eh, thesis], i) => {
    const created = isoDateTime(daysFromToday(-300 + i * 5));
    const id = Number(insCo.run(name, domain, "owners", type === "strategic" ? "Industrial" : "Investment firm", "Dallas", "TX", "manual", created, created).lastInsertRowid);
    insProfile.run(id, type, cl, ch, el, eh, thesis);
    return id;
  });

  const ORDER = ["teaser_sent", "nda_sent", "nda_signed", "cim_sent", "ioi", "mgmt_meeting", "loi", "exclusivity", "closed"];
  const insBuyer = db.prepare("INSERT INTO deal_buyers (deal_id, buyer_company_id, stage, owner_user_id, created_at, updated_at) VALUES (?,?,?,1,?,?)");
  const insHist = db.prepare("INSERT INTO deal_buyer_stage_history (deal_buyer_id, from_stage, to_stage, note, changed_by, created_at) VALUES (?,?,?,?,1,?)");

  // [buyer index, final stage, declined reason or null, ioi low, ioi high, loi value, cash at close %, rollover %]
  function runLog(dealId, startDaysAgo, plan) {
    for (const [bi, final, reason, ioiLo, ioiHi, loi, cash, roll] of plan) {
      const steps = ORDER.slice(0, ORDER.indexOf(final) + 1);
      let t = startDaysAgo - bi * 2;
      const at = () => isoDateTime(daysFromToday(-Math.max(1, t)));
      const id = Number(insBuyer.run(dealId, buyerIds[bi], "teaser_sent", at(), at()).lastInsertRowid);
      const stamps = {};
      let from = null;
      for (const s of steps) {
        stamps[s] = at();
        insHist.run(id, from, s, null, stamps[s]);
        from = s;
        t -= 9;
      }
      let stage = steps.at(-1);
      let declinedFrom = null;
      if (reason) {
        declinedFrom = stage;
        stamps.declined = at();
        insHist.run(id, stage, "declined", reason, stamps.declined);
        stage = "declined";
      }
      const cols = Object.keys(stamps).map((s) => `${s}_at = ?`);
      db.prepare(
        `UPDATE deal_buyers SET stage = ?, declined_from_stage = ?, decline_reason = ?, ioi_low = ?, ioi_high = ?, loi_value = ?, cash_at_close_pct = ?, rollover_pct = ?,
         ${cols.join(", ")}, updated_at = ? WHERE id = ?`
      ).run(stage, declinedFrom, reason, ioiLo, ioiHi, loi, cash, roll, ...Object.values(stamps), Object.values(stamps).at(-1), id);
    }
  }

  const inMarket = deals.filter((d) => d.stage === "In Market");
  const atLoi = deals.filter((d) => d.stage === "LOI");
  const closed = deals.filter((d) => d.stage === "Closed");
  if (inMarket[0]) {
    runLog(inMarket[0].id, 80, [
      [0, "ioi", null, 38_000_000, 44_000_000, null, 85, 15],
      [1, "mgmt_meeting", null, 41_000_000, 47_000_000, null, 80, 20],
      [2, "cim_sent", "Valuation gap", null, null, null, null, null],
      [3, "ioi", null, 36_000_000, 40_000_000, null, 100, null],
      [6, "cim_sent", null, null, null, null, null, null],
      [7, "nda_sent", "Outside thesis", null, null, null, null, null],
      [8, "nda_signed", null, null, null, null, null, null],
      [10, "teaser_sent", null, null, null, null, null, null],
      [11, "teaser_sent", "Timing", null, null, null, null, null],
    ]);
  }
  if (atLoi[0]) {
    runLog(atLoi[0].id, 150, [
      [1, "loi", null, 52_000_000, 58_000_000, 57_500_000, 80, 20],
      [0, "mgmt_meeting", "Valuation gap", 48_000_000, 52_000_000, null, 90, 10],
      [4, "ioi", "Financing", 45_000_000, 50_000_000, null, 70, 30],
      [5, "cim_sent", "Outside thesis", null, null, null, null, null],
      [9, "mgmt_meeting", null, 50_000_000, 55_000_000, null, 100, null],
      [10, "nda_signed", "Too small", null, null, null, null, null],
    ]);
  }
  if (closed[0]) {
    runLog(closed[0].id, 260, [
      [9, "closed", null, 30_000_000, 34_000_000, 33_000_000, 90, 10],
      [3, "ioi", "Valuation gap", 26_000_000, 29_000_000, null, 100, null],
      [2, "cim_sent", "Too small", null, null, null, null, null],
      [6, "mgmt_meeting", "Went quiet", 28_000_000, 31_000_000, null, 100, null],
    ]);
  }
}

// ---------------------------------------------------------------------------
// P4 DOCUMENTS: document ROWS only. The demo ships no real files, so every
// download in the demo answers "File not available in this workspace". The
// sha256 values are well-formed but fake (a hash of a label, not of a file).
// Paste into scripts/seed-demo.mjs just before "// 18. Summary".
// ---------------------------------------------------------------------------
{
  const fakeSha = (label) => createHash("sha256").update(`demo-document:${label}`, "utf8").digest("hex");
  const insDoc = db.prepare(
    `INSERT INTO documents (deal_id, deal_buyer_id, kind, title, doc_key, version, filename, mime, size, sha256, note, uploaded_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const PDF = "application/pdf";
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  // The deals with the busiest buyer logs get a full document set.
  const buyerRows = db
    .prepare("SELECT b.id, b.deal_id, b.stage, b.nda_signed_at, b.loi_at, c.name AS buyer_name FROM deal_buyers b JOIN companies c ON c.id = b.buyer_company_id WHERE b.removed_at IS NULL ORDER BY b.deal_id, b.id")
    .all();
  const byDeal = new Map();
  for (const r of buyerRows) {
    if (!byDeal.has(r.deal_id)) byDeal.set(r.deal_id, []);
    byDeal.get(r.deal_id).push(r);
  }
  const docDeals = [...byDeal.keys()].sort((a, b) => byDeal.get(b).length - byDeal.get(a).length || a - b).slice(0, 3);
  const CODENAMES = ["Falcon", "Juniper", "Harbor"];

  docDeals.forEach((dealId, i) => {
    const code = CODENAMES[i];
    const slug = code.toLowerCase();
    const at = (daysAgo, hour = 10) => {
      const d = daysFromToday(-daysAgo);
      d.setHours(hour, 15 + i * 7, 0, 0);
      return isoDateTime(d);
    };
    const base = 120 - i * 20; // older deals started earlier

    insDoc.run(dealId, null, "engagement_letter", `Project ${code} engagement letter`, `deal:${dealId}:engagement_letter`, 1,
      `Project ${code} - Engagement Letter (executed).pdf`, PDF, 286_412 + i * 1_337, fakeSha(`${dealId}:el:1`), "Countersigned by the seller.", 1, at(base));

    insDoc.run(dealId, null, "teaser", `Project ${code} teaser`, `deal:${dealId}:teaser`, 1,
      `Project ${code} Teaser.pdf`, PDF, 1_214_880 + i * 9_431, fakeSha(`${dealId}:teaser:1`), null, 3, at(base - 12));

    const cim = [
      [1, `Project ${code} CIM draft.docx`, DOCX, 3_902_114, "First draft for seller review.", 3, base - 20],
      [2, `Project ${code} CIM v2.pdf`, PDF, 6_481_227, "Seller comments incorporated.", 1, base - 26],
      [3, `Project ${code} CIM final.pdf`, PDF, 6_730_905, "Final, cleared for distribution under NDA.", 2, base - 30],
    ];
    for (const [ver, filename, mime, size, note, by, ago] of cim) {
      insDoc.run(dealId, null, "cim", `Project ${code} CIM`, `deal:${dealId}:cim`, ver, filename, mime, size + i * 4_111, fakeSha(`${dealId}:cim:${ver}`), note, by, at(ago, 9 + ver));
    }

    // NDAs for buyers who signed one (or, failing that, the first few on the log).
    const rows = byDeal.get(dealId);
    const signed = rows.filter((r) => r.nda_signed_at);
    const ndaRows = (signed.length ? signed : rows).slice(0, 6);
    ndaRows.forEach((r, j) => {
      const when = r.nda_signed_at || at(base - 14 - j);
      insDoc.run(dealId, r.id, "nda", `${r.buyer_name} NDA`, `buyer:${r.id}:nda`, 1,
        `${slug}-nda-executed-${String(j + 1).padStart(2, "0")}.pdf`, PDF, 188_000 + j * 2_417 + i * 311, fakeSha(`${r.id}:nda:1`), null, 1, when);
    });

    // An LOI for any buyer that got that far.
    rows
      .filter((r) => r.loi_at)
      .slice(0, 2)
      .forEach((r, j) => {
        insDoc.run(dealId, r.id, "loi", `${r.buyer_name} LOI`, `buyer:${r.id}:loi`, 1,
          `${slug}-loi-${String(j + 1).padStart(2, "0")}.pdf`, PDF, 402_551 + j * 5_003, fakeSha(`${r.id}:loi:1`), null, 1, r.loi_at);
      });
  });
  console.log(`P4 documents: ${db.prepare("SELECT COUNT(*) AS n FROM documents").get().n} rows on ${docDeals.length} deals (rows only, no files).`);
}

// P5 BANK / FIG demo block. Paste into scripts/seed-demo.mjs just before the
// "// 18. Summary" section. Turns on the regulatory tracker for three deals:
// an LOI deal mid-approval, a Closed deal fully approved, and an In Market deal
// still preparing its filings. Deterministic; dates are relative to today.
{
  const d = (n) => isoDate(daysFromToday(n));
  const loi = deals.find((x) => x.stage === "LOI");
  const closed = deals.find((x) => x.stage === "Closed");
  const market = deals.find((x) => x.stage === "In Market");
  const setFig = db.prepare("UPDATE deals SET fig_track = 1 WHERE id = ?");
  const insFiling = db.prepare(
    `INSERT INTO deal_regulatory_filings
       (deal_id, regulator, agency_label, filed_at, accepted_complete_at, public_notice_at, comment_end_at,
        approval_at, doj_concurrence, consummation_eligible_at, status, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insVote = db.prepare(
    `INSERT INTO deal_shareholder_votes (deal_id, party, record_date, notice_mailed_at, meeting_at, result, votes_for_pct, notes)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  let figFilings = 0;
  let figVotes = 0;

  if (loi) {
    setFig.run(loi.id);
    // FDIC: accepted, notice published, comment period ends in about 10 days.
    insFiling.run(loi.id, "FDIC", null, d(-40), d(-30), d(-20), d(10), null, 0, null, "accepted", "Comment period open. No protests received so far.");
    // State department: filed, waiting on acceptance.
    insFiling.run(loi.id, "STATE", "Texas Department of Banking", d(-38), null, null, null, null, 0, null, "filed", "Examiner asked for updated pro forma capital tables.");
    // Fed (holding company): accepted, approval pending.
    insFiling.run(loi.id, "FED", "Federal Reserve (holding company)", d(-45), d(-28), null, null, null, 0, null, "accepted", "Approval pending.");
    insVote.run(loi.id, "target", d(-5), d(3), d(35), "pending", null, "Proxy statement in final review.");
    insVote.run(loi.id, "acquirer", d(-3), d(6), d(38), "pending", null, null);
    figFilings += 3;
    figVotes += 2;
  }

  if (closed) {
    setFig.run(closed.id);
    insFiling.run(closed.id, "FDIC", null, d(-200), d(-185), d(-180), d(-150), d(-130), 1, d(-115), "approved", "DOJ concurrence shortened the wait to 15 days.");
    insFiling.run(closed.id, "STATE", "Texas Department of Banking", d(-198), d(-180), null, null, d(-140), 0, null, "approved", null);
    insFiling.run(closed.id, "FED", "Federal Reserve (holding company)", d(-200), d(-190), null, null, d(-120), 0, d(-90), "approved", null);
    insVote.run(closed.id, "target", d(-170), d(-160), d(-135), "approved", 91.2, null);
    insVote.run(closed.id, "acquirer", d(-168), d(-158), d(-134), "approved", 88.7, null);
    figFilings += 3;
    figVotes += 2;
  }

  if (market) {
    setFig.run(market.id);
    insFiling.run(market.id, "OCC", null, null, null, null, null, null, 0, null, "preparing", "Pre-filing meeting to schedule once a buyer is picked.");
    figFilings += 1;
  }

  console.log(`  P5 FIG: ${[loi, closed, market].filter(Boolean).length} deals on the regulatory tracker, ${figFilings} filings, ${figVotes} votes`);
}

// ---------------------------------------------------------------------------
// 17e. P3 relationships: referral sources with credit on deals, and people
// who hold roles at more than one company (contact_companies).
// Deterministic, no PRNG draws. Fictional people and firms only.
// ---------------------------------------------------------------------------
{
  // The app backfills this on first open; do it here too so the extra links
  // below sit beside every primary link from the start.
  db.exec(
    `INSERT OR IGNORE INTO contact_companies (contact_id, company_id, is_primary, created_at)
     SELECT id, company_id, 1, created_at FROM contacts WHERE company_id IS NOT NULL`
  );

  // Referral sources: one person at each of six referral-segment firms, kind from the firm.
  const refPeople = db
    .prepare(
      `SELECT MIN(c.id) AS id, co.industry FROM contacts c JOIN companies co ON co.id = c.company_id
       WHERE co.segment_id = 'referrals' AND c.do_not_contact = 0
       GROUP BY co.id ORDER BY co.id DESC LIMIT 6`
    )
    .all();
  const kindFor = (industry, i) => {
    const s = String(industry || "").toLowerCase();
    if (s.includes("cpa")) return "cpa";
    if (s.includes("attorney")) return "attorney";
    if (s.includes("wealth")) return "wealth-manager";
    return ["lender", "banker", "other"][i % 3];
  };
  const setKind = db.prepare("UPDATE contacts SET referral_kind = ? WHERE id = ?");
  refPeople.forEach((p, i) => setKind.run(kindFor(p.industry, i), p.id));

  // Credit six deals, including both Closed deals so credit shows fees.
  const byStage = (s) => deals.filter((d) => d.stage === s);
  const picked = [...byStage("Closed"), byStage("LOI")[0], byStage("In Market")[0], byStage("Engaged")[0], byStage("Passed")[0]].filter(Boolean);
  for (const d of deals) if (picked.length < 6 && !picked.includes(d)) picked.push(d);
  const credit = db.prepare("UPDATE deals SET referral_contact_id = ? WHERE id = ?");
  // The first source is the busiest: two deals, one of them Closed.
  const who = [0, 1, 0, 2, 3, 1];
  if (refPeople.length) {
    picked.slice(0, 6).forEach((d, i) => credit.run(refPeople[who[i] % refPeople.length].id, d.id));
  }

  // People with more than one company: board seats, outside counsel, a former CFO.
  const addLink = db.prepare(
    `INSERT OR IGNORE INTO contact_companies (contact_id, company_id, role, start_date, end_date, is_primary, created_at)
     VALUES (?,?,?,?,?,0,?)`
  );
  const owners = companies.filter((c) => c.segment_id === "owners").slice(0, 12);
  const institutions = companies.filter((c) => c.segment_id === "institutions");
  const ownerPeople = db
    .prepare(
      `SELECT c.id, c.company_id FROM contacts c JOIN companies co ON co.id = c.company_id
       WHERE co.segment_id = 'owners' AND c.do_not_contact = 0 ORDER BY c.id LIMIT 2`
    )
    .all();
  const now = isoDateTime(daysFromToday(-30));
  const links = [];
  if (refPeople[0] && owners[0]) links.push([refPeople[0].id, owners[0].id, "Board member", isoDate(daysFromToday(-1400)), null]);
  if (refPeople[1] && owners[1]) links.push([refPeople[1].id, owners[1].id, "Outside counsel", isoDate(daysFromToday(-900)), null]);
  if (refPeople[2] && owners[2]) links.push([refPeople[2].id, owners[2].id, "Trustee, family trust", isoDate(daysFromToday(-2000)), null]);
  if (refPeople[3] && institutions[0]) links.push([refPeople[3].id, institutions[0].id, "Advisory board", isoDate(daysFromToday(-700)), null]);
  const formerAt = ownerPeople[0] && owners.find((o) => o.id !== ownerPeople[0].company_id);
  if (formerAt) links.push([ownerPeople[0].id, formerAt.id, "Former CFO", isoDate(daysFromToday(-3200)), isoDate(daysFromToday(-1500))]);
  const investorAt = ownerPeople[1] && owners.find((o) => o.id !== ownerPeople[1].company_id && o.id !== formerAt?.id);
  if (investorAt) links.push([ownerPeople[1].id, investorAt.id, "Minority investor", isoDate(daysFromToday(-1100)), null]);
  for (const [contactId, companyId, role, start, end] of links) addLink.run(contactId, companyId, role, start, end, now);
}

// ---------------------------------------------------------------------------
// 18. Summary + integrity checks
// ---------------------------------------------------------------------------
function count(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

console.log("");
console.log("=== Demo workspace seeded: " + DEMO_DB_PATH + " ===");
console.log("");
console.log("Row counts:");
for (const t of ["users", "companies", "contacts", "deals", "tasks", "activities", "signals", "templates", "mailboxes", "outbound_messages", "suppression", "inbound_replies", "audit_log", "profile_facts"]) {
  console.log(`  ${t.padEnd(20)} ${count(t)}`);
}

console.log("");
console.log("Integrity checks:");

// FK check
const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
console.log(`  foreign_key_check: ${fkViolations.length === 0 ? "OK (0 violations)" : "FAILED (" + fkViolations.length + " violations)"}`);
if (fkViolations.length) {
  console.error(fkViolations);
  process.exit(1);
}

// Approved template hash check
const approvedRows = db.prepare("SELECT id, name, subject, body, allowed_merge_fields, content_hash FROM templates WHERE status = 'approved'").all();
let hashOk = true;
for (const row of approvedRows) {
  const fields = JSON.parse(row.allowed_merge_fields);
  const recomputed = contentHash(row.subject, row.body, fields);
  if (recomputed !== row.content_hash) {
    hashOk = false;
    console.error(`  Hash mismatch on template ${row.id} (${row.name})`);
  }
}
console.log(`  approved template hashes: ${hashOk ? `OK (${approvedRows.length} checked)` : "FAILED"}`);
if (!hashOk) process.exit(1);

// Every outbound message: unique unsubscribe token, and a footer that
// contains its own unsubscribe URL and the firm mailing address (what
// checkSend() re-verifies at send time).
{
  const rows = db.prepare("SELECT id, unsubscribe_token, rendered_footer FROM outbound_messages").all();
  const seenTokens = new Set();
  let tokenOk = true;
  let footerOk = true;
  for (const row of rows) {
    if (!row.unsubscribe_token) {
      tokenOk = false;
      console.error(`  Outbound message ${row.id} has no unsubscribe_token.`);
      continue;
    }
    if (seenTokens.has(row.unsubscribe_token)) {
      tokenOk = false;
      console.error(`  Duplicate unsubscribe_token on outbound message ${row.id}.`);
    }
    seenTokens.add(row.unsubscribe_token);
    const expectedFooter = renderedFooterFor(row.unsubscribe_token);
    if (row.rendered_footer !== expectedFooter) {
      footerOk = false;
      console.error(`  Outbound message ${row.id} rendered_footer does not match its own unsubscribe URL.`);
    }
    if (!row.rendered_footer || !row.rendered_footer.includes(FIRM_MAILING_ADDRESS)) {
      footerOk = false;
      console.error(`  Outbound message ${row.id} footer is missing the firm mailing address.`);
    }
  }
  console.log(`  outbound unsubscribe tokens: ${tokenOk ? `OK (${rows.length} unique)` : "FAILED"}`);
  console.log(`  outbound footers: ${footerOk ? `OK (${rows.length} checked)` : "FAILED"}`);
  if (!tokenOk || !footerOk) process.exit(1);
}

// No em dashes in any text column
const EM_DASH = "—";
const textColumnsByTable = {
  companies: ["name", "domain", "industry", "city", "state", "notes"],
  contacts: ["first_name", "last_name", "title", "email"],
  deals: ["title", "situation", "next_step"],
  tasks: ["title"],
  activities: ["body"],
  signals: ["title", "url"],
  templates: ["name", "subject", "body", "review_note"],
  outbound_messages: ["rendered_subject", "rendered_body", "error", "rendered_footer"],
  inbound_replies: ["from_email", "subject", "snippet"],
  audit_log: ["action", "actor_label", "detail_json"],
};
let emDashFound = 0;
for (const [table, cols] of Object.entries(textColumnsByTable)) {
  const rows = db.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all();
  for (const row of rows) {
    for (const col of cols) {
      const val = row[col];
      if (typeof val === "string" && val.includes(EM_DASH)) {
        emDashFound++;
        console.error(`  Em dash found in ${table}.${col}: ${val}`);
      }
    }
  }
}
console.log(`  em dash scan: ${emDashFound === 0 ? "OK (0 found)" : `FAILED (${emDashFound} found)`}`);
if (emDashFound > 0) process.exit(1);

// Every email ends with .example except the two login users
const loginEmails = new Set(["owner@harness.local", "principal@harness.local"]);
let badEmails = 0;
const allEmailSources = [
  ...contacts.map((c) => c.email),
  ...db.prepare("SELECT email FROM users").all().map((r) => r.email),
  ...db.prepare("SELECT email FROM suppression").all().map((r) => r.email),
  ...db.prepare("SELECT from_email FROM inbound_replies").all().map((r) => r.from_email),
];
for (const email of allEmailSources) {
  if (!email) continue;
  if (loginEmails.has(email)) continue;
  if (!email.endsWith(".example") && !email.endsWith(".local")) {
    badEmails++;
    console.error(`  Non-.example email found: ${email}`);
  }
}
// member@harness.local is a login-style user, not a real address; allow .local for users table.
console.log(`  email domain scan: ${badEmails === 0 ? "OK" : `FAILED (${badEmails} bad)`}`);
if (badEmails > 0) process.exit(1);

db.close();

console.log("");
console.log("Demo workspace ready.");
