import type { CompanyWithSignals } from "../../lib/signals/queries";
import DataTable, { type Column } from "../crm/DataTable";
import SignalKindBadge from "./SignalKindBadge";
import CreateDealButton from "./CreateDealButton";
import { ButtonLink } from "../ui/Button";

function formatDate(d: string | null): string {
  if (!d) return "undated";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function SignalsTable({ companies }: { companies: CompanyWithSignals[] }) {
  const columns: Column<CompanyWithSignals>[] = [
    {
      key: "company",
      label: "Company",
      render: (c) => (
        <div>
          <div className="font-medium text-[var(--ink)]">{c.name}</div>
          <div className="text-xs text-[var(--ink-faint)]">
            {c.domain || "domain unknown"}
            {c.city || c.state ? ` · ${[c.city, c.state].filter(Boolean).join(", ")}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "score",
      label: "Score",
      render: (c) => <span className="tabular-nums">{c.signal_score.toFixed(1)}</span>,
    },
    {
      key: "signals",
      label: "Top signals",
      flex: true,
      render: (c) => (
        <ul className="space-y-1.5">
          {c.signals.map((s) => (
            <li key={s.id} className="flex min-w-0 items-center gap-2" title={s.title}>
              <SignalKindBadge kind={s.kind} />
              {s.url ? (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 truncate text-[var(--ink)] underline underline-offset-2 decoration-[var(--rule-strong)] hover:decoration-[var(--ink)]"
                >
                  {s.title}
                </a>
              ) : (
                <span className="min-w-0 truncate text-[var(--ink)]">{s.title}</span>
              )}
              <span className="numeric shrink-0 text-xs text-[var(--ink-faint)]">{formatDate(s.observed_at)}</span>
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "actions",
      label: "Action",
      className: "text-right",
      render: (c) => (
        <div className="flex justify-end">
          {c.open_deal_id ? (
            <ButtonLink href={`/pipeline/${c.open_deal_id}`} variant="secondary" size="sm">
              Open deal
            </ButtonLink>
          ) : (
            <CreateDealButton companyId={c.id} companyName={c.name} />
          )}
        </div>
      ),
    },
  ];

  return <DataTable columns={columns} rows={companies} rowHref={(c) => `/companies/${c.id}`} />;
}
