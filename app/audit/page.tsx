// Read-only, filterable audit trail. Owner and principal only. CSV export.
// There is no update or delete endpoint for audit_log anywhere in this app.
import { db } from "../lib/db";
import { currentUser } from "../lib/session";
import PageHeader from "../components/crm/PageHeader";
import DataTable, { type Column } from "../components/crm/DataTable";
import EmptyState from "../components/crm/EmptyState";
import { ButtonLink, buttonClass } from "../components/ui/Button";
import Select from "../components/ui/Select";
import DateInput from "../components/ui/DateInput";
import { actionLabel } from "../components/outbound/labels";

type AuditRow = {
  id: number;
  actor_label: string | null;
  action: string;
  entity: string | null;
  entity_id: number | null;
  detail_json: string;
  created_at: string;
};

const PAGE_SIZE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entity?: string; from?: string; to?: string; page?: string }>;
}) {
  const user = await currentUser();
  if (!user || (user.role !== "owner" && user.role !== "principal")) {
    return (
      <div className="max-w-2xl">
        <p className="text-sm text-[var(--bad)]">This page is limited to owner and principal roles.</p>
      </div>
    );
  }

  const sp = await searchParams;
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (sp.action) {
    clauses.push("action = ?");
    params.push(sp.action);
  }
  if (sp.entity) {
    clauses.push("entity = ?");
    params.push(sp.entity);
  }
  if (sp.from) {
    // created_at is "YYYY-MM-DD HH:MM:SS"; compare on the date part so the
    // picked day itself is included.
    clauses.push("date(created_at) >= date(?)");
    params.push(sp.from);
  }
  if (sp.to) {
    clauses.push("date(created_at) <= date(?)");
    params.push(sp.to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const page = Math.max(1, Number(sp.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const total = (db().prepare(`SELECT COUNT(*) as c FROM audit_log ${where}`).get(...params) as { c: number }).c;
  const rows = db()
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, offset) as AuditRow[];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const actions = (db().prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all() as { action: string }[]).map(
    (r) => r.action
  );
  const entities = (
    db().prepare("SELECT DISTINCT entity FROM audit_log WHERE entity IS NOT NULL ORDER BY entity").all() as { entity: string }[]
  ).map((r) => r.entity);

  const qs = (overrides: Record<string, string | number | undefined>) => {
    const merged = { ...sp, ...overrides };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== "") p.set(k, String(v));
    }
    return `?${p.toString()}`;
  };

  const columns: Column<AuditRow>[] = [
    { key: "when", label: "When", className: "numeric", render: (r) => new Date(r.created_at.replace(" ", "T") + "Z").toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) },
    { key: "actor", label: "Actor", render: (r) => r.actor_label ?? "System" },
    { key: "action", label: "Action", render: (r) => actionLabel(r.action) },
    { key: "raw_action", label: "System name", priority: 3, render: (r) => <span className="text-xs text-[var(--ink-faint)]">{r.action}</span> },
    { key: "entity", label: "Record", priority: 2, render: (r) => (r.entity ? `${r.entity} #${r.entity_id}` : "None") },
    {
      key: "detail",
      label: "Detail",
      flex: true,
      render: (r) => (
        <span className="block max-w-full truncate text-xs text-[var(--ink-faint)]" title={r.detail_json}>
          {r.detail_json}
        </span>
      ),
    },
  ];

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Audit trail"
        subtitle={`Every state change, append-only. ${total} entries.`}
        actions={
          <ButtonLink
            href={`/api/audit?format=csv${sp.action || sp.entity || sp.from || sp.to ? "&" + qs({ page: undefined }).slice(1) : ""}`}
            variant="secondary"
          >
            Export CSV
          </ButtonLink>
        }
      />

      <form method="get" className="card mb-6 flex flex-wrap items-end gap-3 p-4">
        <Select id="audit-action" name="action" label="Action" defaultValue={sp.action ?? ""} wrapperClassName="w-[180px]">
          <option value="">All</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </Select>
        <Select id="audit-entity" name="entity" label="Entity" defaultValue={sp.entity ?? ""} wrapperClassName="w-[160px]">
          <option value="">All</option>
          {entities.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </Select>
        <DateInput id="audit-from" name="from" label="From" defaultValue={sp.from ?? ""} wrapperClassName="w-[160px]" />
        <DateInput id="audit-to" name="to" label="To" defaultValue={sp.to ?? ""} wrapperClassName="w-[160px]" />
        <button type="submit" className={buttonClass("secondary", "md")}>
          Filter
        </button>
        {(sp.action || sp.entity || sp.from || sp.to) && (
          <ButtonLink href="/audit" variant="quiet" size="sm">
            Clear
          </ButtonLink>
        )}
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No matching entries" detail="Adjust the filters above, or clear them to see the full trail." />
      ) : (
        <DataTable columns={columns} rows={rows} />
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center gap-3 text-sm">
          <a
            href={page > 1 ? qs({ page: page - 1 }) : undefined}
            aria-disabled={page <= 1}
            className={`inline-flex min-h-[44px] items-center rounded-[var(--radius-sm)] border border-[var(--rule-strong)] px-3 ${page <= 1 ? "pointer-events-none opacity-40" : "hover:bg-[var(--surface)]"}`}
          >
            Previous
          </a>
          <span className="text-[var(--ink-soft)]">
            Page {page} of {totalPages}
          </span>
          <a
            href={page < totalPages ? qs({ page: page + 1 }) : undefined}
            aria-disabled={page >= totalPages}
            className={`inline-flex min-h-[44px] items-center rounded-[var(--radius-sm)] border border-[var(--rule-strong)] px-3 ${page >= totalPages ? "pointer-events-none opacity-40" : "hover:bg-[var(--surface)]"}`}
          >
            Next
          </a>
        </div>
      )}
    </div>
  );
}
