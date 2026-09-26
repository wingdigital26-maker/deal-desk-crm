// Referral-source kinds. Pure constants, safe to import from client components.
// A contact with a kind set is a referral source; null means it is not one.
export const REFERRAL_KINDS = ["cpa", "attorney", "wealth-manager", "lender", "banker", "other"] as const;
export type ReferralKind = (typeof REFERRAL_KINDS)[number];

const LABELS: Record<ReferralKind, string> = {
  cpa: "CPA",
  attorney: "Attorney",
  "wealth-manager": "Wealth manager",
  lender: "Lender",
  banker: "Banker",
  other: "Other",
};

export function referralKindLabel(kind: string | null | undefined): string {
  if (!kind) return "Not set";
  return LABELS[kind as ReferralKind] ?? kind;
}
