import { db } from "../lib/db";
import { firm } from "../../firm.config";
import PageHeader from "../components/crm/PageHeader";
import EmptyState from "../components/crm/EmptyState";
import CsvImport from "../components/crm/CsvImport";
import ContactsTable, { type ContactRow } from "../components/crm/ContactsTable";
import { Button, ButtonLink } from "../components/ui/Button";
import Select from "../components/ui/Select";
import { EMAIL_CHECK_FILTERS, LABELLED_EMAIL_STATUSES, VERIFIED_EMAIL_STATUSES } from "../components/crm/format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; segment?: string; email_check?: string; page?: string; queueTemplate?: string }>;
}) {
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const segment = sp.segment ?? "";
  const emailCheck = sp.email_check ?? "";
  const requestedPage = Math.max(1, Math.floor(Number(sp.page ?? "1")) || 1);
  const queueTemplateId = sp.queueTemplate ? Number(sp.queueTemplate) : undefined;

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q) {
    where.push("(contacts.first_name LIKE ? OR contacts.last_name LIKE ? OR contacts.email LIKE ? OR companies.name LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (segment) {
    where.push("companies.segment_id = ?");
    params.push(segment);
  }
  // Each filter matches exactly the rows whose "Email check" label reads the
  // same (see emailCheck() in format.ts), so a filter never hides a row it names.
  switch (emailCheck) {
    case "valid":
      where.push(
        `contacts.email IS NOT NULL AND contacts.email_status IN (${VERIFIED_EMAIL_STATUSES.map(() => "?").join(",")}) AND contacts.do_not_contact = 0`
      );
      params.push(...VERIFIED_EMAIL_STATUSES);
      break;
    case "accept-all":
    case "no-mx":
      where.push("contacts.email IS NOT NULL AND contacts.email_status = ? AND contacts.do_not_contact = 0");
      params.push(emailCheck);
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
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = db()
    .prepare(`SELECT COUNT(*) AS n FROM contacts LEFT JOIN companies ON companies.id = contacts.company_id ${whereSql}`)
    .get(...params) as { n: number };
  // A page past the end (an old link, a narrowed filter) shows the last page.
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total.n / PAGE_SIZE)));
  const rows = db()
    .prepare(
      `SELECT contacts.*, companies.id AS company_id, companies.name AS company_name, companies.city AS company_city, companies.segment_id AS company_segment_id, lt.last_touch
       FROM contacts
       LEFT JOIN companies ON companies.id = contacts.company_id
       LEFT JOIN (SELECT contact_id, MAX(created_at) AS last_touch FROM activities GROUP BY contact_id) lt
         ON lt.contact_id = contacts.id
       ${whereSql} ORDER BY contacts.updated_at DESC, contacts.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as ContactRow[];

  const totalPages = Math.max(1, Math.ceil(total.n / PAGE_SIZE));
  const qs = (overrides: Record<string, string>) => {
    const merged = { q, segment, email_check: emailCheck, queueTemplate: sp.queueTemplate ?? "", ...overrides };
    const params = new URLSearchParams();
    Object.entries(merged).forEach(([k, v]) => v && params.set(k, v));
    return `?${params.toString()}`;
  };

  const headerBlock = (
    <div key="contacts-header">
      <PageHeader
        title="Contacts"
        subtitle={`${total.n} ${total.n === 1 ? "contact" : "contacts"}`}
        actions={
          <>
            <CsvImport trigger="Import a list" />
            <ButtonLink href="/contacts/new" variant="secondary">
              New contact
            </ButtonLink>
          </>
        }
      />

      <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
        {/* Keep "queue for this template" mode across a filter change. */}
        {queueTemplateId ? <input type="hidden" name="queueTemplate" value={queueTemplateId} /> : null}
        <div className="min-w-[140px] max-w-[220px] flex-1 basis-[140px]">
          <label htmlFor="q" className="label mb-1 block text-[var(--ink-soft)]">
            Search
          </label>
          <input
            id="q"
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search name, email or company"
            className="h-[44px] w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-[15px] text-[var(--ink)] outline-none focus-visible:border-[var(--accent)]"
          />
        </div>
        <Select id="segment" name="segment" label="Segment" defaultValue={segment} wrapperClassName="w-[120px]">
          <option value="">Any</option>
          {firm.segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select id="email_check" name="email_check" label="Email check" defaultValue={emailCheck} wrapperClassName="w-[150px]">
          {EMAIL_CHECK_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {(q || segment || emailCheck) && (
          <ButtonLink href={queueTemplateId ? `/contacts?queueTemplate=${queueTemplateId}` : "/contacts"} variant="quiet" size="sm">
            Clear
          </ButtonLink>
        )}
      </form>
    </div>
  );

  const paginationBlock =
    totalPages > 1 ? (
      <div key="contacts-pagination" className="mt-4 flex items-center justify-between text-sm text-[var(--ink-soft)]">
        <span>
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <ButtonLink href={qs({ page: String(page - 1) })} variant="secondary" size="sm">
              Previous
            </ButtonLink>
          )}
          {page < totalPages && (
            <ButtonLink href={qs({ page: String(page + 1) })} variant="secondary" size="sm">
              Next
            </ButtonLink>
          )}
        </div>
      </div>
    ) : null;

  if (rows.length === 0) {
    return (
      <div>
        {headerBlock}
        <EmptyState
          title={q || segment || emailCheck ? "No contacts match those filters" : "No contacts yet"}
          detail={
            q || segment || emailCheck
              ? "Try clearing a filter or searching a different name."
              : "Add a contact by hand, or import a list from Apollo or a scraper export."
          }
          action={<ButtonLink href="/contacts/new">New contact</ButtonLink>}
        />
      </div>
    );
  }

  return (
    <ContactsTable
      rows={rows}
      showCompanyColumn
      initialQueueTemplateId={queueTemplateId}
      header={headerBlock}
      pagination={paginationBlock}
    />
  );
}
