// Maps Apollo search results into companies + contacts rows.
// Rules: source is always "apollo"; apollo_id is stored for traceability;
// dedupe on domain (companies) / email (contacts); never overwrite a field a
// human has already edited manually; never import a contact whose email is
// in the suppression list as contactable (it is stored do_not_contact=1
// instead of being silently dropped, so the record and its history exist).
import { db, audit } from "../db";
import { syncFromContact } from "../contactCompanies";
import type { ApolloOrganization, ApolloPerson } from "./client";

type CompanyRow = {
  id: number;
  name: string;
  domain: string | null;
  source: string;
  manually_edited: number | null;
};

type ContactRow = {
  id: number;
  email: string | null;
  source: string;
  manually_edited: number | null;
};

// `manually_edited` is not in the current schema. If it is added later this
// import stays correct; until then a row is treated as "manually edited"
// only if its source is not apollo/import/signal-engine (i.e. a human typed
// it directly), which is the safest inference from the existing columns.
function isManuallyOwned(source: string): boolean {
  return source === "manual";
}

function isSuppressed(email: string | null): boolean {
  if (!email) return false;
  const row = db().prepare("SELECT email FROM suppression WHERE email = ?").get(email.toLowerCase());
  return !!row;
}

export type ImportSelection = {
  people?: ApolloPerson[];
  companies?: ApolloOrganization[];
  segmentId: string;
  userId: number;
};

export type ImportResult = {
  companiesCreated: number;
  companiesMatched: number;
  contactsCreated: number;
  contactsSkippedSuppressed: number;
  contactsSkippedNoIdentity: number;
};

function upsertCompanyFromOrg(org: ApolloOrganization, segmentId: string): number | null {
  const domain = org.domain?.toLowerCase() || null;
  const name = org.name?.trim();
  if (!name) return null;

  let existing: CompanyRow | undefined;
  if (domain) {
    existing = db().prepare("SELECT id, name, domain, source, NULL as manually_edited FROM companies WHERE domain = ?").get(domain) as
      | CompanyRow
      | undefined;
  }

  if (existing) {
    // Never overwrite a manually-edited row. Only fill genuinely empty
    // fields on rows that are not human-owned.
    if (!isManuallyOwned(existing.source)) {
      const fields: string[] = [];
      const values: unknown[] = [];
      const patch: Record<string, unknown> = {
        industry: org.industry,
        city: org.city,
        state: org.state,
        employees: org.estimatedEmployees,
      };
      for (const [col, val] of Object.entries(patch)) {
        if (val === null || val === undefined) continue;
        const current = db().prepare(`SELECT ${col} FROM companies WHERE id = ?`).get(existing.id) as Record<string, unknown>;
        if (current[col] === null || current[col] === undefined || current[col] === "") {
          fields.push(`${col} = ?`);
          values.push(val);
        }
      }
      if (fields.length) {
        fields.push("updated_at = datetime('now')");
        values.push(existing.id);
        db().prepare(`UPDATE companies SET ${fields.join(", ")} WHERE id = ?`).run(...(values as (string | number | null)[]));
      }
    }
    return existing.id;
  }

  const result = db()
    .prepare(
      `INSERT INTO companies (name, domain, segment_id, industry, city, state, employees, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'apollo')`
    )
    .run(name, domain, segmentId, org.industry, org.city, org.state, org.estimatedEmployees);
  return Number(result.lastInsertRowid);
}

function companyIdForPerson(person: ApolloPerson, segmentId: string): number | null {
  const domain = person.organizationDomain?.toLowerCase() || null;
  const name = person.organizationName?.trim();

  if (domain) {
    const existing = db().prepare("SELECT id FROM companies WHERE domain = ?").get(domain) as { id: number } | undefined;
    if (existing) return existing.id;
  }
  if (!name) return null;

  const result = db()
    .prepare(`INSERT INTO companies (name, domain, segment_id, source) VALUES (?, ?, ?, 'apollo')`)
    .run(name, domain, segmentId);
  return Number(result.lastInsertRowid);
}

export function importApolloSelection(sel: ImportSelection): ImportResult {
  const out: ImportResult = {
    companiesCreated: 0,
    companiesMatched: 0,
    contactsCreated: 0,
    contactsSkippedSuppressed: 0,
    contactsSkippedNoIdentity: 0,
  };

  for (const org of sel.companies ?? []) {
    const before = org.domain
      ? (db().prepare("SELECT id FROM companies WHERE domain = ?").get(org.domain.toLowerCase()) as { id: number } | undefined)
      : undefined;
    const id = upsertCompanyFromOrg(org, sel.segmentId);
    if (id === null) continue;
    if (before) out.companiesMatched += 1;
    else out.companiesCreated += 1;
  }

  for (const person of sel.people ?? []) {
    const email = person.email?.toLowerCase().trim() || null;
    const hasIdentity = !!(email || person.linkedinUrl || (person.firstName && person.lastName && person.organizationDomain));
    if (!hasIdentity) {
      out.contactsSkippedNoIdentity += 1;
      continue;
    }

    const companyId = companyIdForPerson(person, sel.segmentId);
    const suppressed = isSuppressed(email);
    if (suppressed) out.contactsSkippedSuppressed += 1;

    let existing: ContactRow | undefined;
    if (email) {
      existing = db().prepare("SELECT id, email, source, NULL as manually_edited FROM contacts WHERE email = ?").get(email) as
        | ContactRow
        | undefined;
    }

    if (existing) {
      if (!isManuallyOwned(existing.source)) {
        const fields: string[] = [];
        const values: unknown[] = [];
        const patch: Record<string, unknown> = {
          first_name: person.firstName,
          last_name: person.lastName,
          title: person.title,
          linkedin_url: person.linkedinUrl,
          apollo_id: person.id,
        };
        for (const [col, val] of Object.entries(patch)) {
          if (val === null || val === undefined) continue;
          const current = db().prepare(`SELECT ${col} FROM contacts WHERE id = ?`).get(existing.id) as Record<string, unknown>;
          if (current[col] === null || current[col] === undefined || current[col] === "") {
            fields.push(`${col} = ?`);
            values.push(val);
          }
        }
        if (suppressed) {
          fields.push("do_not_contact = 1");
        }
        if (fields.length) {
          fields.push("updated_at = datetime('now')");
          values.push(existing.id);
          db().prepare(`UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`).run(...(values as (string | number | null)[]));
          syncFromContact(existing.id);
        }
      }
      continue;
    }

    const insertedContact = db()
      .prepare(
        `INSERT INTO contacts (company_id, first_name, last_name, title, email, email_status, linkedin_url, source, apollo_id, do_not_contact)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'apollo', ?, ?)`
      )
      .run(
        companyId,
        person.firstName,
        person.lastName,
        person.title,
        email,
        person.emailStatus,
        person.linkedinUrl,
        person.id,
        suppressed ? 1 : 0
      );
    if (companyId) syncFromContact(Number(insertedContact.lastInsertRowid));
    out.contactsCreated += 1;
  }

  audit({
    actorUserId: sel.userId,
    action: "import.apollo",
    entity: "import",
    detail: {
      segment_id: sel.segmentId,
      ...out,
    },
  });

  return out;
}
