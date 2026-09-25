import { db } from "../lib/db";
import { firm } from "../../firm.config";
import PageHeader from "../components/crm/PageHeader";
import DataTable, { type Column } from "../components/crm/DataTable";
import EmptyState from "../components/crm/EmptyState";
import { titleCaseCompanyName, sourceLabel } from "../components/crm/format";
import { Button, ButtonLink } from "../components/ui/Button";
import Select from "../components/ui/Select";

export const dynamic = "force-dynamic";

type CompanyRow = {
  id: number;
  name: string;
  domain: string | null;
  segment_id: string;
  city: string | null;
  state: string | null;
  source: string;
  signal_score: number;
  updated_at: string;
};

const SOURCES = ["manual", "apollo", "signal-engine", "import", "tx-franchise-registry"];
const PAGE_SIZE = 50;

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; segment?: string; source?: string; sort?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const segment = sp.segment ?? "";
  const source = sp.source ?? "";
  const sort = sp.sort === "signal_score" ? "signal_score" : sp.sort === "name" ? "name" : "updated_at";
  const requestedPage = Math.max(1, Math.floor(Number(sp.page ?? "1")) || 1);

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q) {
    where.push("(name LIKE ? OR domain LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (segment) {
    where.push("segment_id = ?");
    params.push(segment);
  }
  if (source) {
    where.push("source = ?");
    params.push(source);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // id is the tie-breaker: thousands of registry rows share one updated_at,
  // and without it page 2 can repeat or skip rows from page 1.
  const orderSql =
    sort === "signal_score"
      ? "signal_score DESC, id DESC"
      : sort === "name"
        ? "name COLLATE NOCASE ASC, id ASC"
        : "updated_at DESC, id DESC";

  const total = db()
    .prepare(`SELECT COUNT(*) AS n FROM companies ${whereSql}`)
    .get(...params) as { n: number };
  // A page past the end (an old link, a narrowed filter) shows the last page.
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total.n / PAGE_SIZE)));
  const rows = db()
    .prepare(`SELECT * FROM companies ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as CompanyRow[];

  const segmentLabel = (id: string) => firm.segments.find((s) => s.id === id)?.label ?? id;

  const columns: Column<CompanyRow>[] = [
    { key: "name", label: "Company", flex: true, render: (r) => titleCaseCompanyName(r.name) },
    { key: "segment", label: "Segment", render: (r) => segmentLabel(r.segment_id) },
    { key: "location", label: "Location", render: (r) => [r.city, r.state].filter(Boolean).join(", ") || "Not set" },
    { key: "domain", label: "Website", priority: 3, render: (r) => r.domain ?? "Not set" },
    { key: "source", label: "Source", priority: 3, render: (r) => sourceLabel(r.source) },
    { key: "signal_score", label: "Signal", className: "text-right numeric", render: (r) => r.signal_score.toFixed(1) },
    {
      key: "updated_at",
      label: "Updated",
      className: "text-right numeric",
      priority: 2,
      render: (r) => new Date(r.updated_at.replace(" ", "T") + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total.n / PAGE_SIZE));
  const qs = (overrides: Record<string, string>) => {
    const merged = { q, segment, source, sort, ...overrides };
    const params = new URLSearchParams();
    Object.entries(merged).forEach(([k, v]) => v && params.set(k, v));
    return `?${params.toString()}`;
  };

  return (
    <div>
      <PageHeader
        title="Companies"
        subtitle={`${total.n} ${total.n === 1 ? "company" : "companies"} in the pipeline universe`}
        actions={<ButtonLink href="/companies/new">New company</ButtonLink>}
      />

      <form className="mb-4 flex flex-wrap items-end gap-2" method="get">
        <div className="min-w-[180px] max-w-[260px] flex-1 basis-[180px]">
          <label htmlFor="q" className="label mb-1 block text-[var(--ink-soft)]">
            Search
          </label>
          <input
            id="q"
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search name or domain"
            className="h-[44px] w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-[15px] text-[var(--ink)] outline-none focus-visible:border-[var(--accent)]"
          />
        </div>
        <Select id="segment" name="segment" label="Segment" defaultValue={segment} wrapperClassName="w-[170px]">
          <option value="">All segments</option>
          {firm.segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select id="source" name="source" label="Source" defaultValue={source} wrapperClassName="w-[150px]">
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {sourceLabel(s)}
            </option>
          ))}
        </Select>
        <Select id="sort" name="sort" label="Sort" defaultValue={sort} wrapperClassName="w-[190px]">
          <option value="updated_at">Recently updated</option>
          <option value="signal_score">Signal score</option>
          <option value="name">Name</option>
        </Select>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {(q || segment || source || sort !== "updated_at") && (
          <ButtonLink href="/companies" variant="quiet" size="sm">
            Clear
          </ButtonLink>
        )}
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={q || segment || source ? "No companies match those filters" : "No companies yet"}
          detail={
            q || segment || source
              ? "Try clearing a filter or searching a different name or domain."
              : "Add the first company by hand, or bring one in from Sourcing or a CSV import."
          }
          action={<ButtonLink href="/companies/new">New company</ButtonLink>}
        />
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowHref={(r) => `/companies/${r.id}`} />
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm text-[var(--ink-soft)]">
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
          )}
        </>
      )}
    </div>
  );
}
