// Buyer stages for a sell-side process, in order. Plain module: safe on the
// server and the client. declined is terminal and sits outside the forward
// order, so Advance/Back can never land on it by accident.
export const BUYER_STAGES = [
  "teaser_sent",
  "nda_sent",
  "nda_signed",
  "cim_sent",
  "ioi",
  "mgmt_meeting",
  "loi",
  "exclusivity",
  "closed",
  "declined",
] as const;
export type BuyerStage = (typeof BUYER_STAGES)[number];

export const FORWARD_STAGES = BUYER_STAGES.filter((s) => s !== "declined") as Exclude<BuyerStage, "declined">[];

export const BUYER_STAGE_LABELS: Record<BuyerStage, string> = {
  teaser_sent: "Teaser sent",
  nda_sent: "NDA sent",
  nda_signed: "NDA signed",
  cim_sent: "CIM sent",
  ioi: "IOI",
  mgmt_meeting: "Mgmt meeting",
  loi: "LOI",
  exclusivity: "Exclusivity",
  closed: "Closed",
  declined: "Declined",
};

export const BUYER_TYPES = ["pe", "strategic", "family-office", "other"] as const;
export type BuyerType = (typeof BUYER_TYPES)[number];
export const BUYER_TYPE_LABELS: Record<BuyerType, string> = {
  pe: "Private equity",
  strategic: "Strategic",
  "family-office": "Family office",
  other: "Other",
};

export const isBuyerStage = (s: unknown): s is BuyerStage => typeof s === "string" && (BUYER_STAGES as readonly string[]).includes(s);

/** Milestone column stamped the first time a buyer reaches a stage. */
export const milestoneColumn = (s: BuyerStage) => `${s}_at`;

/** Position in the forward order; declined is -1. */
export const stageRank = (s: BuyerStage) => (FORWARD_STAGES as string[]).indexOf(s);

/** Next forward stage, or null at closed or declined. */
export function nextStage(s: BuyerStage): BuyerStage | null {
  const i = stageRank(s);
  return i < 0 || i >= FORWARD_STAGES.length - 1 ? null : FORWARD_STAGES[i + 1];
}

/** Previous forward stage, or null at teaser_sent or declined. */
export function prevStage(s: BuyerStage): BuyerStage | null {
  const i = stageRank(s);
  return i <= 0 ? null : FORWARD_STAGES[i - 1];
}

/** Terms (IOI, LOI) are meaningful from the IOI stage on, or for a buyer that declined after bidding. */
export function hasTerms(b: { stage: BuyerStage; declined_from_stage?: string | null }): boolean {
  const s = b.stage === "declined" && isBuyerStage(b.declined_from_stage) ? b.declined_from_stage : b.stage;
  return stageRank(s) >= stageRank("ioi");
}
