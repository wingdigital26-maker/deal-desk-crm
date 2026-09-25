import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "../lib/session";
import { countCompaniesBySource, countCompaniesWithSignals } from "../lib/signals/queries";
import { firm } from "../../firm.config";
import PageHeader from "../components/crm/PageHeader";

export const metadata = { title: `Sourcing | ${firm.productName}` };

export default async function SourcingHub() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const bySource = countCompaniesBySource();
  const apolloCount = bySource["apollo"] || 0;
  // Companies the collector has actually posted a signal against. Counting by
  // companies.source missed every registry company it found signals for.
  const signalCount = countCompaniesWithSignals();
  const totalCompanies = Object.values(bySource).reduce((a, b) => a + b, 0);

  return (
    <div>
      <PageHeader
        title="Sourcing"
        subtitle="Two ways new companies enter the desk: a live search, or a free automatic collector."
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <Link
          href="/sourcing/apollo"
          className="card lift block p-6"
        >
          <div className="mb-2 text-[12px] font-semibold text-[var(--ink-soft)]">Search</div>
          <h2 className="display mb-2 text-lg text-[var(--ink)]">Apollo</h2>
          <p className="mb-4 text-sm text-[var(--ink-soft)]">
            Search a business contact database for owners and executives. Needs the firm&apos;s
            Apollo account connected.
          </p>
          <div className="text-sm text-[var(--ink)]">
            <span className="font-medium">{apolloCount}</span> {apolloCount === 1 ? "company" : "companies"} sourced from Apollo
          </div>
        </Link>

        <Link
          href="/sourcing/signals"
          className="card lift block p-6"
        >
          <div className="mb-2 text-[12px] font-semibold text-[var(--ink-soft)]">Free, automatic</div>
          <h2 className="display mb-2 text-lg text-[var(--ink)]">Signals</h2>
          <p className="mb-4 text-sm text-[var(--ink-soft)]">
            Companies showing signs of change: hiring, news, filings, government contracts.
            Collected from public sources at no cost.
          </p>
          <div className="text-sm text-[var(--ink)]">
            <span className="font-medium">{signalCount}</span> {signalCount === 1 ? "company" : "companies"} found by the collector
          </div>
        </Link>
      </div>

      {totalCompanies === 0 && (
        <p className="mt-8 text-sm text-[var(--ink-faint)]">
          Nothing in the desk yet. Run the signal collector or bring in an Apollo search to start.
        </p>
      )}
    </div>
  );
}
