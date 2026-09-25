import { redirect } from "next/navigation";
import { currentUser } from "../../lib/session";
import { db } from "../../lib/db";
import { firm } from "../../../firm.config";
import { listRankedCompanies } from "../../lib/signals/queries";
import PageHeader from "../../components/crm/PageHeader";
import EmptyState from "../../components/crm/EmptyState";
import SignalsFilters from "../../components/sourcing/SignalsFilters";
import SignalsTable from "../../components/sourcing/SignalsTable";

export const metadata = { title: `Signals | ${firm.productName}` };

function lastSignalsRunAt(): string | null {
  const row = db()
    .prepare("SELECT created_at FROM audit_log WHERE action = 'signals.run' ORDER BY id DESC LIMIT 1")
    .get() as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

function formatRunDate(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function SignalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const kind = typeof sp.kind === "string" && sp.kind ? sp.kind : undefined;
  const segment = typeof sp.segment === "string" && sp.segment ? sp.segment : undefined;
  const minScore = typeof sp.min_score === "string" && sp.min_score ? Number(sp.min_score) : undefined;
  const since = typeof sp.since === "string" && sp.since ? sp.since : undefined;

  const companies = listRankedCompanies({ kind, segment, minScore, since });
  const lastRun = lastSignalsRunAt();

  return (
    <div>
      <PageHeader
        title="Signals"
        subtitle="Companies ranked by signal strength: hiring, ownership-transition news, SEC filings and federal contract activity, collected weekly with no paid data source."
      />

      <SignalsFilters segments={firm.segments} />

      {companies.length === 0 ? (
        <EmptyState
          title="No signals yet"
          detail={
            lastRun
              ? `The collector last ran ${formatRunDate(lastRun)} and found nothing that matches these filters.`
              : "The collector runs weekly on the office machine and has not run yet."
          }
          action={
            <details className="text-left text-xs text-[var(--ink-faint)]">
              <summary className="cursor-pointer select-none">For whoever maintains this</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-[var(--paper)] p-3 text-[var(--ink)]">
                python scrapers/harness_signals.py run --db data/harness.db
              </pre>
              <p className="mt-2 max-w-md">
                Scheduled weekly; see scrapers/README.md for the Task Scheduler / cron setup.
              </p>
            </details>
          }
        />
      ) : (
        <SignalsTable companies={companies} />
      )}
    </div>
  );
}
