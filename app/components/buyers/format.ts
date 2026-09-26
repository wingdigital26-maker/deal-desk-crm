// Display helpers for buyer rows, shared by the buyer log, the terms grid and the report.
import { formatMoney } from "../../lib/dealMath";
import { BUYER_STAGE_LABELS, isBuyerStage } from "../../lib/buyerStages";
import type { BuyerRow } from "../../lib/buyers";

export function stageText(b: Pick<BuyerRow, "stage" | "declined_from_stage">) {
  return b.stage === "declined" && isBuyerStage(b.declined_from_stage)
    ? `Declined after ${BUYER_STAGE_LABELS[b.declined_from_stage]}`
    : BUYER_STAGE_LABELS[b.stage];
}

export function ioiText(b: Pick<BuyerRow, "ioi_low" | "ioi_high">) {
  if (b.ioi_low == null && b.ioi_high == null) return "";
  if (b.ioi_low != null && b.ioi_high != null && b.ioi_low !== b.ioi_high) return `${formatMoney(b.ioi_low)} to ${formatMoney(b.ioi_high)}`;
  return formatMoney(b.ioi_low ?? b.ioi_high);
}
