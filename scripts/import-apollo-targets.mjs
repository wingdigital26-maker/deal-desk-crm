// One-off importer: brings a saved Apollo people-search export (first name, masked
// last name, title, company, apollo_id) into the workspace database as companies + contacts.
// Usage: node scripts/import-apollo-targets.mjs <people.json> [--db data/harness.db] [--segment owners]
// Never invents data: missing email, domain and city stay empty. Idempotent on apollo_id.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (!file) {
  console.error("Give the path to the people JSON export.");
  process.exit(1);
}
const dbPath = path.resolve(opt("db", "data/harness.db"));
const segment = opt("segment", "owners");
if (dbPath.endsWith("demo.db")) {
  console.error("Refusing to import real records into the demo workspace.");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const people = Array.isArray(raw) ? raw : raw.people || raw.contacts || [];
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

const findCompany = db.prepare("SELECT id FROM companies WHERE lower(name) = lower(?)");
const addCompany = db.prepare(
  "INSERT INTO companies (name, domain, segment_id, industry, city, state, source) VALUES (?,?,?,?,?,?, 'apollo')"
);
const findContact = db.prepare("SELECT id FROM contacts WHERE apollo_id = ?");
const addContact = db.prepare(
  "INSERT INTO contacts (company_id, first_name, last_name, title, email, email_status, source, apollo_id) VALUES (?,?,?,?,?,?, 'apollo', ?)"
);

let companies = 0, contacts = 0, skipped = 0, masked = 0;
for (const p of people) {
  if (!p.apollo_id || !p.company) { skipped++; continue; }
  if (findContact.get(p.apollo_id)) { skipped++; continue; }
  let company = findCompany.get(p.company);
  if (!company) {
    const r = addCompany.run(p.company, p.domain || null, segment, p.industry || null, p.city || null, p.state || null);
    company = { id: Number(r.lastInsertRowid) };
    companies++;
  }
  if (/\*/.test(p.last_name || "")) masked++;
  addContact.run(company.id, p.first_name || null, p.last_name || null, p.title || null, p.email || null, p.email ? "unknown" : null, p.apollo_id);
  contacts++;
}
db.prepare(
  "INSERT INTO audit_log (actor_label, action, entity, detail_json) VALUES ('import-script', 'contacts.import', 'contacts', ?)"
).run(JSON.stringify({ source: path.basename(file), companies, contacts, skipped, masked_last_names: masked, with_email: people.filter((p) => p.email).length }));
console.log(JSON.stringify({ db: dbPath, companies, contacts, skipped, masked_last_names: masked, with_email: people.filter((p) => p.email).length }, null, 1));
