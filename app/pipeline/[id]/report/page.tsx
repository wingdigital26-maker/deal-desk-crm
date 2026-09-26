import { notFound, redirect } from "next/navigation";
import { currentUser } from "../../../lib/session";
import { firm } from "../../../../firm.config";
import { sellerReport } from "../../../lib/sellerReport";
import { BUYER_STAGE_LABELS, BUYER_TYPE_LABELS, FORWARD_STAGES, hasTerms, stageRank, type BuyerType } from "../../../lib/buyerStages";
import { ButtonLink } from "../../../components/ui/Button";
import PrintButton from "../../../components/buyers/PrintButton";
import { ioiText, stageText } from "../../../components/buyers/format";
import { formatMoney } from "../../../lib/dealMath";

export const metadata = { title: `Seller report | ${firm.productName}` };

// One-click seller status report. Printable (the app frame hides on print).
// Bid values are OFF by default: many bankers show the seller stage counts,
// not prices, to avoid anchoring. ?values=1 turns them on for this printout.
export default async function SellerReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ values?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const report = sellerReport(id);
  if (!report) notFound();
  const showValues = (await searchParams).values === "1";

  const { deal, items, reached, funnel } = report;
  const active = items.filter((b) => b.stage !== "declined").sort((a, b) => stageRank(b.stage) - stageRank(a.stage) || a.buyer_name.localeCompare(b.buyer_name));
  const declined = items.filter((b) => b.stage === "declined");
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const bids = active.filter(hasTerms);

  return (
    <div className="mx-auto max-w-[920px]">
      <div className="no-print mb-5 flex flex-wrap items-center gap-2">
        <ButtonLink href={`/pipeline/${deal.id}`} variant="quiet" size="sm" className="!px-0">
          Back to deal
        </ButtonLink>
        <span className="flex-1" />
        <ButtonLink href={`/pipeline/${deal.id}/report${showValues ? "" : "?values=1"}`} variant="secondary" size="sm">
          {showValues ? "Hide bid values" : "Show bid values"}
        </ButtonLink>
        <ButtonLink href={`/api/deals/${deal.id}/seller-report?format=csv`} variant="secondary" size="sm">
          Download CSV
        </ButtonLink>
        <ButtonLink href={`/api/deals/${deal.id}/seller-report?format=xlsx`} variant="secondary" size="sm">
          Download Excel
        </ButtonLink>
        <PrintButton />
      </div>
      <p className="no-print mb-4 text-[12px] text-[var(--ink-faint)]">
        Downloads are recorded in the audit log. This report is for the seller only; send it yourself through your firm&apos;s channels.
      </p>

      <article className="card p-8">
        <header className="border-b border-[var(--rule)] pb-5">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">Buyer process update · {today}</div>
          <h1 className="display mt-1 text-[28px] font-bold text-[var(--ink)]">{deal.company_name}</h1>
          <div className="mt-1 text-sm text-[var(--ink-soft)]">
            {deal.title}
            {deal.expected_close ? ` · target close ${new Date(deal.expected_close + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })}` : ""}
          </div>
        </header>

        <section className="print-break-avoid mt-6">
          <h2 className="text-[15px] font-bold text-[var(--ink)]">Where the process stands</h2>
          {items.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--ink-soft)]">No buyers have been contacted yet.</p>
          ) : (
            <ol className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {FORWARD_STAGES.filter((s) => s !== "closed").map((s) => (
                <li key={s} className="rounded-[10px] bg-[var(--paper)] px-3 py-2">
                  <div className="text-[11px] font-semibold text-[var(--ink-soft)]">{BUYER_STAGE_LABELS[s]}</div>
                  <div className="numeric text-[22px] font-bold text-[var(--ink)]">{reached[s]}</div>
                </li>
              ))}
            </ol>
          )}
          {items.length > 0 && (
            <p className="mt-2 text-[12px] text-[var(--ink-soft)]">
              Counts are buyers who reached each step. {funnel.declined} {funnel.declined === 1 ? "buyer has" : "buyers have"} stepped away.
            </p>
          )}
        </section>

        {showValues && bids.length > 0 && (
          <section className="print-break-avoid mt-8">
            <h2 className="text-[15px] font-bold text-[var(--ink)]">Indications received</h2>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--rule)] text-left text-[12px] text-[var(--ink-soft)]">
                  <th className="py-1.5 pr-3">Buyer</th>
                  <th className="py-1.5 pr-3">Stage</th>
                  <th className="py-1.5 pr-3">IOI</th>
                  <th className="py-1.5 pr-3">LOI</th>
                  <th className="py-1.5">Cash at close</th>
                </tr>
              </thead>
              <tbody>
                {bids.map((b) => (
                  <tr key={b.id} className="border-b border-[var(--rule)] last:border-0">
                    <td className="py-1.5 pr-3 font-medium text-[var(--ink)]">{b.buyer_name}</td>
                    <td className="py-1.5 pr-3 text-[var(--ink-soft)]">{stageText(b)}</td>
                    <td className="numeric py-1.5 pr-3">{ioiText(b) || "-"}</td>
                    <td className="numeric py-1.5 pr-3">{b.loi_value != null ? formatMoney(b.loi_value) : "-"}</td>
                    <td className="numeric py-1.5">{b.cash_at_close_pct != null ? `${b.cash_at_close_pct}%` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {active.length > 0 && (
          <section className="mt-8">
            <h2 className="text-[15px] font-bold text-[var(--ink)]">Active buyers ({active.length})</h2>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--rule)] text-left text-[12px] text-[var(--ink-soft)]">
                  <th className="py-1.5 pr-3">Buyer</th>
                  <th className="py-1.5 pr-3">Type</th>
                  <th className="py-1.5">Stage</th>
                </tr>
              </thead>
              <tbody>
                {active.map((b) => (
                  <tr key={b.id} className="print-break-avoid border-b border-[var(--rule)] last:border-0">
                    <td className="py-1.5 pr-3 font-medium text-[var(--ink)]">{b.buyer_name}</td>
                    <td className="py-1.5 pr-3 text-[var(--ink-soft)]">{b.buyer_type ? BUYER_TYPE_LABELS[b.buyer_type as BuyerType] ?? b.buyer_type : ""}</td>
                    <td className="py-1.5 text-[var(--ink)]">{stageText(b)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {declined.length > 0 && (
          <section className="mt-8">
            <h2 className="text-[15px] font-bold text-[var(--ink)]">Stepped away ({declined.length})</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {declined.map((b) => (
                <li key={b.id} className="print-break-avoid">
                  <span className="font-medium text-[var(--ink)]">{b.buyer_name}</span>
                  <span className="text-[var(--ink-soft)]">
                    {" "}
                    {stageText(b).replace("Declined", "declined")}
                    {b.decline_reason ? `: ${b.decline_reason}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-10 border-t border-[var(--rule)] pt-3 text-[11px] text-[var(--ink-faint)]">
          Prepared by {firm.name}. Confidential. Prepared for the seller only.
        </footer>
      </article>
    </div>
  );
}
