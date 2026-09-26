// Seller status report: one read of the deal and its buyer log, shared by the
// printable page and the CSV/XLSX export, so the two can never disagree.
import { db } from "./db";
import { funnel, listBuyers, reached, stageHistory, type BuyerRow } from "./buyers";
import { BUYER_STAGE_LABELS, BUYER_TYPE_LABELS, FORWARD_STAGES, hasTerms, isBuyerStage, type BuyerType } from "./buyerStages";
import type { Column, Sheet } from "./export";

export type SellerReport = {
  deal: { id: number; title: string; stage: string; company_name: string; expected_close: string | null };
  items: BuyerRow[];
  funnel: ReturnType<typeof funnel>;
  reached: Record<string, number>;
  generated_at: string;
};

export function sellerReport(dealId: number): SellerReport | null {
  const deal = db()
    .prepare("SELECT d.id, d.title, d.stage, d.expected_close, c.name AS company_name FROM deals d JOIN companies c ON c.id = d.company_id WHERE d.id = ?")
    .get(dealId) as SellerReport["deal"] | undefined;
  if (!deal) return null;
  const items = listBuyers(dealId);
  return { deal, items, funnel: funnel(items), reached: reached(items), generated_at: new Date().toISOString() };
}

const day = (s: string | null) => (s ? s.slice(0, 10) : "");
const typeLabel = (t: string | null) => (t ? BUYER_TYPE_LABELS[t as BuyerType] ?? t : "");
const stageLabel = (b: BuyerRow) =>
  b.stage === "declined" && isBuyerStage(b.declined_from_stage)
    ? `Declined after ${BUYER_STAGE_LABELS[b.declined_from_stage]}`
    : BUYER_STAGE_LABELS[b.stage];

export const BUYER_COLUMNS: Column<BuyerRow>[] = [
  { key: "buyer", label: "Buyer", value: (b) => b.buyer_name },
  { key: "type", label: "Type", value: (b) => typeLabel(b.buyer_type) },
  { key: "stage", label: "Stage", value: stageLabel },
  ...FORWARD_STAGES.map((s) => ({ key: `${s}_at`, label: BUYER_STAGE_LABELS[s], value: (b: BuyerRow) => day(b[`${s}_at`]) })),
  { key: "ioi_low", label: "IOI low", value: (b) => b.ioi_low, numFmt: "integer" as const },
  { key: "ioi_high", label: "IOI high", value: (b) => b.ioi_high, numFmt: "integer" as const },
  { key: "loi_value", label: "LOI value", value: (b) => b.loi_value, numFmt: "integer" as const },
  { key: "decline_reason", label: "Decline reason", value: (b) => b.decline_reason },
];

export const TERMS_COLUMNS: Column<BuyerRow>[] = [
  { key: "buyer", label: "Buyer", value: (b) => b.buyer_name },
  { key: "stage", label: "Stage", value: stageLabel },
  { key: "ioi_low", label: "IOI low", value: (b) => b.ioi_low, numFmt: "integer" },
  { key: "ioi_high", label: "IOI high", value: (b) => b.ioi_high, numFmt: "integer" },
  { key: "loi_value", label: "LOI value", value: (b) => b.loi_value, numFmt: "integer" },
  { key: "cash", label: "Cash at close %", value: (b) => b.cash_at_close_pct },
  { key: "rollover", label: "Rollover %", value: (b) => b.rollover_pct },
  { key: "earnout", label: "Earnout", value: (b) => b.earnout },
  { key: "financing", label: "Financing", value: (b) => b.financing },
  { key: "diligence", label: "Diligence days", value: (b) => b.diligence_days },
  { key: "exclusivity", label: "Exclusivity days", value: (b) => b.exclusivity_days },
  { key: "structure", label: "Structure notes", value: (b) => b.structure_notes },
];

type SummaryRow = { stage: string; reached: number; now: number };

export function reportSheets(r: SellerReport): Sheet<unknown>[] {
  const summary: SummaryRow[] = [
    ...FORWARD_STAGES.map((s) => ({ stage: BUYER_STAGE_LABELS[s], reached: r.reached[s], now: r.funnel[s] })),
    { stage: "Declined", reached: r.funnel.declined, now: r.funnel.declined },
  ];
  const history = stageHistory(r.deal.id);
  return [
    {
      name: "Summary",
      columns: [
        { key: "stage", label: "Stage", value: (x: SummaryRow) => x.stage },
        { key: "reached", label: "Buyers who reached it", value: (x: SummaryRow) => x.reached },
        { key: "now", label: "Buyers there now", value: (x: SummaryRow) => x.now },
      ],
      rows: summary,
    } as Sheet<unknown>,
    { name: "Buyers", columns: BUYER_COLUMNS, rows: r.items } as Sheet<unknown>,
    { name: "Terms", columns: TERMS_COLUMNS, rows: r.items.filter(hasTerms) } as Sheet<unknown>,
    {
      name: "Stage history",
      columns: [
        { key: "when", label: "When", value: (h: (typeof history)[number]) => h.created_at },
        { key: "buyer", label: "Buyer", value: (h: (typeof history)[number]) => h.buyer_name },
        { key: "from", label: "From", value: (h: (typeof history)[number]) => (isBuyerStage(h.from_stage) ? BUYER_STAGE_LABELS[h.from_stage] : "") },
        { key: "to", label: "To", value: (h: (typeof history)[number]) => (isBuyerStage(h.to_stage) ? BUYER_STAGE_LABELS[h.to_stage] : h.to_stage) },
        { key: "note", label: "Note", value: (h: (typeof history)[number]) => h.note },
        { key: "by", label: "By", value: (h: (typeof history)[number]) => h.user_name },
      ],
      rows: history,
    } as Sheet<unknown>,
  ];
}
