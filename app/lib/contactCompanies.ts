// A contact's companies (P3). contacts.company_id is the current primary
// company and every other screen still reads it; the junction holds every
// role the person has had, with dates. setPrimary() is the only writer of
// contacts.company_id here, and it keeps the two in step.
import { db } from "./db";
import * as v from "./validate";

export type CompanyLink = {
  id: number;
  contact_id: number;
  company_id: number;
  company_name: string;
  company_domain: string | null;
  role: string | null;
  start_date: string | null;
  end_date: string | null;
  is_primary: number;
};

export type LinkedContact = {
  contact_id: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  role: string | null;
  start_date: string | null;
  end_date: string | null;
  is_primary: number;
};

export function linksForContact(contactId: number): CompanyLink[] {
  return db()
    .prepare(
      `SELECT cc.id, cc.contact_id, cc.company_id, co.name AS company_name, co.domain AS company_domain,
              cc.role, cc.start_date, cc.end_date, cc.is_primary
       FROM contact_companies cc JOIN companies co ON co.id = cc.company_id
       WHERE cc.contact_id = ?
       ORDER BY cc.is_primary DESC, (cc.end_date IS NOT NULL), cc.start_date DESC, co.name COLLATE NOCASE`
    )
    .all(contactId) as CompanyLink[];
}

/** People tied to a company through the junction whose primary company is somewhere else. */
export function otherContactsForCompany(companyId: number): LinkedContact[] {
  return db()
    .prepare(
      `SELECT c.id AS contact_id, c.first_name, c.last_name, c.title, cc.role, cc.start_date, cc.end_date, cc.is_primary
       FROM contact_companies cc JOIN contacts c ON c.id = cc.contact_id
       WHERE cc.company_id = ? AND (c.company_id IS NULL OR c.company_id != cc.company_id)
       ORDER BY (cc.end_date IS NOT NULL), c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE`
    )
    .all(companyId) as LinkedContact[];
}

/**
 * Make `companyId` the contact's primary company (null clears it). Adds the
 * link if missing, flips is_primary so exactly that link carries it, and
 * writes contacts.company_id to match.
 */
export function setPrimary(contactId: number, companyId: number | null) {
  const d = db();
  if (companyId != null) {
    d.prepare("INSERT OR IGNORE INTO contact_companies (contact_id, company_id, is_primary) VALUES (?, ?, 1)").run(contactId, companyId);
  }
  d.prepare("UPDATE contact_companies SET is_primary = CASE WHEN company_id = ? THEN 1 ELSE 0 END WHERE contact_id = ?").run(
    companyId ?? -1,
    contactId
  );
  d.prepare("UPDATE contacts SET company_id = ?, updated_at = datetime('now') WHERE id = ? AND company_id IS NOT ?").run(
    companyId,
    contactId,
    companyId
  );
}

/** After a bulk path wrote contacts.company_id directly, mirror it into the junction. */
export function syncFromContact(contactId: number) {
  const row = db().prepare("SELECT company_id FROM contacts WHERE id = ?").get(contactId) as { company_id: number | null } | undefined;
  if (row) setPrimary(contactId, row.company_id);
}

export type LinkInput = { role: string | null; start_date: string | null; end_date: string | null };

/** Validates role and dates. Only keys present in the body are returned. Throws ValidationError. */
export function parseLinkFields(body: Record<string, unknown>): Partial<LinkInput> {
  const out: Partial<LinkInput> = {};
  if ("role" in body) out.role = v.boundedString("role", body.role, 120);
  if ("start_date" in body) out.start_date = v.isoDate("start_date", body.start_date);
  if ("end_date" in body) out.end_date = v.isoDate("end_date", body.end_date);
  return out;
}

export function checkDateOrder(start: string | null | undefined, end: string | null | undefined) {
  if (start && end && end < start) throw new v.ValidationError("end_date", "end_date must be on or after start_date");
}

export type LinkResult = { ok: true; link: CompanyLink } | { ok: false; status: number; error: string };

export function addLink(contactId: number, companyId: number, fields: Partial<LinkInput>, primary: boolean): LinkResult {
  const d = db();
  if (!d.prepare("SELECT 1 FROM companies WHERE id = ?").get(companyId)) return { ok: false, status: 400, error: "Unknown company" };
  if (d.prepare("SELECT 1 FROM contact_companies WHERE contact_id = ? AND company_id = ?").get(contactId, companyId)) {
    return { ok: false, status: 409, error: "This person is already linked to that company" };
  }
  checkDateOrder(fields.start_date, fields.end_date);
  d.prepare("INSERT INTO contact_companies (contact_id, company_id, role, start_date, end_date, is_primary) VALUES (?,?,?,?,?,0)").run(
    contactId,
    companyId,
    fields.role ?? null,
    fields.start_date ?? null,
    fields.end_date ?? null
  );
  // The first company a contact gets is their primary one.
  const current = d.prepare("SELECT company_id FROM contacts WHERE id = ?").get(contactId) as { company_id: number | null };
  if (primary || current.company_id == null) setPrimary(contactId, companyId);
  return { ok: true, link: getLink(contactId, companyId)! };
}

export function getLink(contactId: number, companyId: number): CompanyLink | undefined {
  return linksForContact(contactId).find((l) => l.company_id === companyId);
}

export function updateLink(
  contactId: number,
  companyId: number,
  fields: Partial<LinkInput>,
  primary: boolean | undefined
): LinkResult {
  const existing = getLink(contactId, companyId);
  if (!existing) return { ok: false, status: 404, error: "No link to that company" };
  checkDateOrder(
    "start_date" in fields ? fields.start_date : existing.start_date,
    "end_date" in fields ? fields.end_date : existing.end_date
  );
  const keys = Object.keys(fields) as (keyof LinkInput)[];
  if (keys.length) {
    db()
      .prepare(`UPDATE contact_companies SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE contact_id = ? AND company_id = ?`)
      .run(...keys.map((k) => fields[k] ?? null), contactId, companyId);
  }
  if (primary === true) setPrimary(contactId, companyId);
  if (primary === false && existing.is_primary) setPrimary(contactId, null);
  return { ok: true, link: getLink(contactId, companyId)! };
}

export function removeLink(contactId: number, companyId: number): { ok: boolean; wasPrimary: boolean } {
  const existing = getLink(contactId, companyId);
  if (!existing) return { ok: false, wasPrimary: false };
  // Clear the primary first so contacts.company_id never points at a company
  // the person is no longer linked to (the startup backfill would re-add it).
  if (existing.is_primary) setPrimary(contactId, null);
  db().prepare("DELETE FROM contact_companies WHERE contact_id = ? AND company_id = ?").run(contactId, companyId);
  return { ok: true, wasPrimary: !!existing.is_primary };
}
