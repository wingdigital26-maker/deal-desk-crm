// WHERE clauses for the Companies and Contacts lists, shared by the list pages
// and their exports so an export always holds exactly the rows the list shows.
import { VERIFIED_EMAIL_STATUSES, LABELLED_EMAIL_STATUSES } from "../components/crm/format";

export type Where = { sql: string; params: (string | number)[] };

export type CompanyFilters = { q: string; segment: string; source: string };
export type ContactFilters = { q: string; segment: string; emailCheck: string };

const str = (v: string | null | undefined) => (v ?? "").trim();

export function companyFiltersFrom(get: (k: string) => string | null | undefined): CompanyFilters {
  return { q: str(get("q")), segment: str(get("segment")), source: str(get("source")) };
}

export function contactFiltersFrom(get: (k: string) => string | null | undefined): ContactFilters {
  return { q: str(get("q")), segment: str(get("segment")), emailCheck: str(get("email_check")) };
}

/** For `FROM companies` (unaliased). */
export function companyWhere(f: CompanyFilters): Where {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.q) {
    where.push("(name LIKE ? OR domain LIKE ?)");
    params.push(`%${f.q}%`, `%${f.q}%`);
  }
  if (f.segment) {
    where.push("segment_id = ?");
    params.push(f.segment);
  }
  if (f.source) {
    where.push("source = ?");
    params.push(f.source);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/** For `FROM contacts LEFT JOIN companies ON companies.id = contacts.company_id`. */
export function contactWhere(f: ContactFilters): Where {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.q) {
    where.push("(contacts.first_name LIKE ? OR contacts.last_name LIKE ? OR contacts.email LIKE ? OR companies.name LIKE ?)");
    params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  if (f.segment) {
    where.push("companies.segment_id = ?");
    params.push(f.segment);
  }
  // Each filter matches exactly the rows whose "Email check" label reads the
  // same (see emailCheck() in format.ts), so a filter never hides a row it names.
  switch (f.emailCheck) {
    case "valid":
      where.push(
        `contacts.email IS NOT NULL AND contacts.email_status IN (${VERIFIED_EMAIL_STATUSES.map(() => "?").join(",")}) AND contacts.do_not_contact = 0`
      );
      params.push(...VERIFIED_EMAIL_STATUSES);
      break;
    case "accept-all":
    case "no-mx":
      where.push("contacts.email IS NOT NULL AND contacts.email_status = ? AND contacts.do_not_contact = 0");
      params.push(f.emailCheck);
      break;
    case "unknown":
      where.push(
        `contacts.email IS NOT NULL AND (contacts.email_status IS NULL OR contacts.email_status NOT IN (${LABELLED_EMAIL_STATUSES.map(() => "?").join(",")})) AND contacts.do_not_contact = 0`
      );
      params.push(...LABELLED_EMAIL_STATUSES);
      break;
    case "no-email":
      where.push("contacts.email IS NULL AND contacts.do_not_contact = 0");
      break;
    case "dnc":
      where.push("contacts.do_not_contact = 1");
      break;
    default:
      break;
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/** Query string for the export links: only the filters that are set. */
export function filterQuery(f: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString();
}
