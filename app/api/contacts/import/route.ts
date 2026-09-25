export const runtime = "nodejs";
// CSV import for contacts (and, incidentally, the companies they belong to).
// Body: { rows: Record<string,string>[], mapping: Record<targetField, csvHeader> }
// Target fields: first_name, last_name, title, email, phone, linkedin_url, company_name
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import { isValidEmail } from "../../../lib/csv";
import { normalizeDomain } from "../../companies/route";

type Mapping = Partial<Record<
  "first_name" | "last_name" | "title" | "email" | "phone" | "linkedin_url" | "company_name" | "company_domain",
  string
>>;

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.rows) || !body.mapping) {
    return Response.json({ error: "rows and mapping are required" }, { status: 400 });
  }
  const rows: Record<string, string>[] = body.rows;
  const mapping: Mapping = body.mapping;
  if (rows.length === 0) return Response.json({ error: "No rows to import" }, { status: 400 });
  if (rows.length > 5000) return Response.json({ error: "Import is capped at 5000 rows at a time" }, { status: 400 });

  let created = 0;
  let updated = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  const findCompanyByDomain = db().prepare("SELECT id FROM companies WHERE domain = ?");
  const findCompanyByName = db().prepare("SELECT id FROM companies WHERE name = ? COLLATE NOCASE");
  const insertCompany = db().prepare(
    `INSERT INTO companies (name, domain, source) VALUES (?, ?, 'import')`
  );
  const findContactByEmail = db().prepare("SELECT id FROM contacts WHERE email = ?");
  const insertContact = db().prepare(
    `INSERT INTO contacts (company_id, first_name, last_name, title, email, phone, linkedin_url, source)
     VALUES (?,?,?,?,?,?,?,'import')`
  );
  const updateContact = db().prepare(
    `UPDATE contacts SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name),
     title = COALESCE(?, title), phone = COALESCE(?, phone), linkedin_url = COALESCE(?, linkedin_url),
     company_id = COALESCE(?, company_id), updated_at = datetime('now') WHERE id = ?`
  );

  for (const row of rows) {
    const get = (field: keyof Mapping) => {
      const header = mapping[field];
      return header ? (row[header] ?? "").trim() : "";
    };

    const firstName = get("first_name") || null;
    const lastName = get("last_name") || null;
    const title = get("title") || null;
    const email = get("email").toLowerCase() || null;
    const phone = get("phone") || null;
    const linkedinUrl = get("linkedin_url") || null;
    const companyName = get("company_name") || null;
    const companyDomainRaw = get("company_domain") || null;

    if (!firstName && !lastName) {
      skippedInvalid++;
      continue;
    }
    if (email && !isValidEmail(email)) {
      skippedInvalid++;
      continue;
    }

    let companyId: number | null = null;
    if (companyDomainRaw || companyName) {
      const domain = companyDomainRaw ? normalizeDomain(companyDomainRaw) : null;
      const existing = domain
        ? (findCompanyByDomain.get(domain) as { id: number } | undefined)
        : companyName
        ? (findCompanyByName.get(companyName) as { id: number } | undefined)
        : undefined;
      if (existing) {
        companyId = existing.id;
      } else {
        const result = insertCompany.run(companyName || domain || "Unnamed company", domain);
        companyId = Number(result.lastInsertRowid);
      }
    }

    if (email) {
      const existingContact = findContactByEmail.get(email) as { id: number } | undefined;
      if (existingContact) {
        updateContact.run(firstName, lastName, title, phone, linkedinUrl, companyId, existingContact.id);
        updated++;
        continue;
      }
    }

    try {
      insertContact.run(companyId, firstName, lastName, title, email, phone, linkedinUrl);
      created++;
    } catch {
      // Most likely a race on the email unique index.
      skippedDuplicate++;
    }
  }

  const counts = { created, updated, skipped_duplicate: skippedDuplicate, skipped_invalid: skippedInvalid };
  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "contact.import",
    entity: "contact",
    detail: { rows: rows.length, ...counts },
  });

  return Response.json(counts);
}
