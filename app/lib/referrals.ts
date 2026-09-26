// Referral sources and the credit they carry (P3). A referral source is a
// contact: either marked with a referral_kind, or credited on a deal through
// deals.referral_contact_id. Credit is read straight from the deals, so moving
// a deal's source moves the credit with no second write.
import { db } from "./db";
import { expectedFee } from "./dealMath";
import { firm } from "../../firm.config";

export type ReferralSource = {
  contact_id: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company_id: number | null;
  firm_name: string | null;
  referral_kind: string | null;
  touch_every_days: number | null;
  last_touch: string | null;
  deals_sourced: number;
  open: number;
  won: number;
  lost: number;
  won_fees: number;        // expected fee summed over won deals that carry fee inputs
  won_without_fee: number; // won deals with no fee inputs, so the fee column never overstates
};

type DealRow = {
  referral_contact_id: number;
  stage: string;
  retainer: number | null;
  success_fee_pct: number | null;
  enterprise_value: number | null;
  probability: number | null;
};

/**
 * Closed stages split by outcome using the config's stage probability:
 * 100 means won ("Closed"), anything else lost ("Passed"). No stage name is
 * written here, so a re-skinned firm config works unchanged.
 */
export function outcomeStages(cfg: { closedStages: readonly string[]; stageProbability: Record<string, number> } = firm) {
  const won = cfg.closedStages.filter((s) => (cfg.stageProbability[s] ?? 0) >= 100);
  const lost = cfg.closedStages.filter((s) => !won.includes(s));
  return { won, lost };
}

export function referralSources(): ReferralSource[] {
  const people = db()
    .prepare(
      `SELECT c.id AS contact_id, c.first_name, c.last_name, c.title, c.company_id, co.name AS firm_name,
              c.referral_kind, c.touch_every_days,
              (SELECT MAX(a.created_at) FROM activities a WHERE a.contact_id = c.id) AS last_touch
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
       WHERE c.referral_kind IS NOT NULL OR c.id IN (SELECT referral_contact_id FROM deals WHERE referral_contact_id IS NOT NULL)`
    )
    .all() as Omit<ReferralSource, "deals_sourced" | "open" | "won" | "lost" | "won_fees" | "won_without_fee">[];

  const deals = db()
    .prepare(
      `SELECT referral_contact_id, stage, retainer, success_fee_pct, enterprise_value, probability
       FROM deals WHERE referral_contact_id IS NOT NULL`
    )
    .all() as DealRow[];

  const { won, lost } = outcomeStages();
  const credit = new Map<number, Pick<ReferralSource, "deals_sourced" | "open" | "won" | "lost" | "won_fees" | "won_without_fee">>();
  for (const d of deals) {
    const c = credit.get(d.referral_contact_id) ?? { deals_sourced: 0, open: 0, won: 0, lost: 0, won_fees: 0, won_without_fee: 0 };
    c.deals_sourced += 1;
    if (won.includes(d.stage)) {
      c.won += 1;
      const fee = expectedFee(d);
      if (fee == null) c.won_without_fee += 1;
      else c.won_fees += fee;
    } else if (lost.includes(d.stage)) c.lost += 1;
    else c.open += 1;
    credit.set(d.referral_contact_id, c);
  }

  return people
    .map((p) => ({ ...p, ...(credit.get(p.contact_id) ?? { deals_sourced: 0, open: 0, won: 0, lost: 0, won_fees: 0, won_without_fee: 0 }) }))
    .sort(
      (a, b) =>
        b.won_fees - a.won_fees ||
        b.deals_sourced - a.deals_sourced ||
        (a.last_name ?? "").localeCompare(b.last_name ?? "") ||
        a.contact_id - b.contact_id
    );
}

/** One contact's credit, for the contact page. */
export function referralCredit(contactId: number): { deals_sourced: number; open: number; won: number } {
  const { won, lost } = outcomeStages();
  const stages = db().prepare("SELECT stage FROM deals WHERE referral_contact_id = ?").all(contactId) as { stage: string }[];
  return {
    deals_sourced: stages.length,
    open: stages.filter((d) => !won.includes(d.stage) && !lost.includes(d.stage)).length,
    won: stages.filter((d) => won.includes(d.stage)).length,
  };
}
