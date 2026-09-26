// Referral sources: the CPAs, attorneys, wealth managers and lenders who send
// deals, with the credit each one carries. Credit is read from the deals'
// "Sourced by", so it is never typed in by hand.
import { firm } from "../../../firm.config";
import PageHeader from "../../components/crm/PageHeader";
import DataTable, { type Column } from "../../components/crm/DataTable";
import EmptyState from "../../components/crm/EmptyState";
import ExportLinks from "../../components/crm/ExportLinks";
import { displayName, relativeDays } from "../../components/crm/format";
import { referralSources, type ReferralSource } from "../../lib/referrals";
import { referralKindLabel } from "../../lib/referralKinds";
import { cadenceLabel } from "../../lib/cadenceLabels";
import { formatMoney } from "../../lib/dealMath";

export const dynamic = "force-dynamic";
export const metadata = { title: `Referral sources | ${firm.productName}` };

type Row = ReferralSource & { id: number };

export default function ReferralSourcesPage() {
  const rows: Row[] = referralSources().map((r) => ({ ...r, id: r.contact_id }));
  const credited = rows.filter((r) => r.deals_sourced > 0).length;

  const columns: Column<Row>[] = [
    {
      key: "name",
      label: "Name",
      render: (r) => <span className="font-medium">{displayName(r)}</span>,
    },
    { key: "firm", label: "Firm", flex: true, render: (r) => r.firm_name ?? <span className="text-[var(--ink-faint)]">Not set</span> },
    { key: "kind", label: "Kind", render: (r) => (r.referral_kind ? referralKindLabel(r.referral_kind) : <span className="text-[var(--ink-faint)]">Not set</span>) },
    { key: "sourced", label: "Deals sourced", className: "text-right numeric", render: (r) => r.deals_sourced },
    { key: "open", label: "Open", className: "text-right numeric", render: (r) => r.open },
    { key: "won", label: "Closed", className: "text-right numeric", render: (r) => r.won },
    {
      key: "fees",
      label: "Closed-deal fees",
      className: "text-right numeric",
      render: (r) =>
        r.won === 0 ? (
          <span className="text-[var(--ink-faint)]">None yet</span>
        ) : r.won_without_fee === r.won ? (
          <span className="text-[var(--ink-faint)]">No fee on file</span>
        ) : (
          <span title={r.won_without_fee ? `${r.won_without_fee} closed deal(s) have no fee on file` : undefined}>
            {formatMoney(r.won_fees)}
            {r.won_without_fee ? "+" : ""}
          </span>
        ),
    },
    { key: "touch", label: "Last touch", priority: 2, render: (r) => relativeDays(r.last_touch) },
    { key: "cadence", label: "Touch cadence", priority: 3, render: (r) => (r.touch_every_days ? cadenceLabel(r.touch_every_days) : <span className="text-[var(--ink-faint)]">Not set</span>) },
  ];

  return (
    <div>
      <PageHeader
        title="Referral sources"
        subtitle={
          rows.length
            ? `${rows.length} ${rows.length === 1 ? "person" : "people"}, ${credited} with deals credited`
            : "People who send you deals, and the credit they carry."
        }
        actions={rows.length ? <ExportLinks entity="referrals" /> : undefined}
      />
      {rows.length === 0 ? (
        <EmptyState
          title="No referral sources yet"
          detail="Mark a contact as a CPA, attorney, wealth manager or lender on their page, or credit a deal to someone under Sourced by on the deal page."
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowHref={(r) => `/contacts/${r.contact_id}`} />
      )}
    </div>
  );
}
