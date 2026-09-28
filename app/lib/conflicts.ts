// Buyer conflict check. When buyers are added to a deal, flag any buyer company
// that is:
//   (a) the seller on another open deal,
//   (b) a buyer at LOI or exclusivity on another open deal, or
//   (c) the firm of the referral source credited on this deal.
// Warnings never block the add; the banker reviews them. Every hit writes a
// `conflict.flagged` audit row with the full detail for compliance.
//
// Walls: a hit on a deal the user cannot see is still flagged (the control
// must work across walls), but the warning does not name that deal or what
// the company is doing on it. The audit row carries the detail for the desk owner.
import { db, audit } from "./db";
import { firm } from "../../firm.config";
import { canSeeDeal, visibleDealIds, type AccessUser } from "./dealAccess";

// How a conflict names a deal: its code name, else its title (never guessed from the company).
const dealLabel = (d: { code_name: string | null; title: string }) => d.code_name?.trim() || d.title;

export type ConflictKind = "seller_elsewhere" | "buyer_late_elsewhere" | "referral_firm";

export type ConflictWarning = {
  buyer_company_id: number;
  buyer_name: string;
  kind: ConflictKind;
  /** The other deal, or null when it is behind a wall for this user (or kind is referral_firm). */
  other_deal_id: number | null;
  message: string;
};

type Hit = { buyer_company_id: number; buyer_name: string; kind: ConflictKind; deal_id: number; deal_label: string; detail?: string };

const LATE_BUYER_STAGES = ["loi", "exclusivity"] as const;
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

function hits(dealId: number, companyIds: number[]): Hit[] {
  if (!companyIds.length) return [];
  const closed = firm.closedStages as readonly string[];
  const ids = [...new Set(companyIds)];
  const out: Hit[] = [];

  const sellers = db()
    .prepare(
      `SELECT c.id AS buyer_company_id, c.name AS buyer_name, d.id AS deal_id, d.code_name, d.title
       FROM deals d JOIN companies c ON c.id = d.company_id
       WHERE d.company_id IN (${placeholders(ids.length)}) AND d.id != ? AND d.stage NOT IN (${placeholders(closed.length)})`
    )
    .all(...ids, dealId, ...closed) as { buyer_company_id: number; buyer_name: string; deal_id: number; code_name: string | null; title: string }[];
  for (const r of sellers) out.push({ ...r, kind: "seller_elsewhere", deal_label: dealLabel(r) });

  const late = db()
    .prepare(
      `SELECT b.buyer_company_id, bc.name AS buyer_name, d.id AS deal_id, d.code_name, d.title, b.stage
       FROM deal_buyers b JOIN deals d ON d.id = b.deal_id
       JOIN companies bc ON bc.id = b.buyer_company_id
       WHERE b.buyer_company_id IN (${placeholders(ids.length)}) AND b.deal_id != ? AND b.removed_at IS NULL
         AND b.stage IN (${placeholders(LATE_BUYER_STAGES.length)}) AND d.stage NOT IN (${placeholders(closed.length)})`
    )
    .all(...ids, dealId, ...LATE_BUYER_STAGES, ...closed) as {
    buyer_company_id: number;
    buyer_name: string;
    deal_id: number;
    code_name: string | null;
    title: string;
    stage: string;
  }[];
  for (const r of late) out.push({ ...r, kind: "buyer_late_elsewhere", deal_label: dealLabel(r), detail: r.stage === "loi" ? "LOI" : "exclusivity" });

  // (c) The referral source's firm: their primary company or any current link.
  const referral = db()
    .prepare(
      `SELECT co.id AS buyer_company_id, co.name AS buyer_name,
              TRIM(COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,'')) AS person
       FROM deals d JOIN contacts r ON r.id = d.referral_contact_id
       JOIN companies co ON co.id IN (
         SELECT r.company_id UNION SELECT cc.company_id FROM contact_companies cc WHERE cc.contact_id = r.id AND cc.end_date IS NULL)
       WHERE d.id = ? AND co.id IN (${placeholders(ids.length)})`
    )
    .all(dealId, ...ids) as { buyer_company_id: number; buyer_name: string; person: string }[];
  for (const r of referral) out.push({ ...r, kind: "referral_firm", deal_id: dealId, deal_label: "", detail: r.person || "the referral source" });

  return out;
}

function message(h: Hit, visible: boolean): string {
  if (h.kind === "referral_firm") return `${h.buyer_name} is the firm of ${h.detail}, who is credited with sourcing this deal.`;
  if (!visible) return `${h.buyer_name} has a possible conflict on a deal you are not on. Check with the desk owner before sending anything.`;
  if (h.kind === "seller_elsewhere") return `${h.buyer_name} is the seller on another open deal, ${h.deal_label}.`;
  return `${h.buyer_name} is at ${h.detail} as a buyer on another open deal, ${h.deal_label}.`;
}

/** Conflicts for buyer companies just added to `dealId`, worded for this user. */
export function buyerConflicts(dealId: number, companyIds: number[], user: AccessUser): ConflictWarning[] {
  return hits(dealId, companyIds).map((h) => {
    const visible = h.kind === "referral_firm" || canSeeDeal(user, h.deal_id);
    return {
      buyer_company_id: h.buyer_company_id,
      buyer_name: h.buyer_name,
      kind: h.kind,
      other_deal_id: h.kind === "referral_firm" || !visible ? null : h.deal_id,
      message: message(h, visible),
    };
  });
}

/** One `conflict.flagged` audit row per hit, with the full detail (the audit log is owner-only). */
export function recordConflicts(dealId: number, companyIds: number[], userId: number) {
  for (const h of hits(dealId, companyIds)) {
    audit({
      actorUserId: userId,
      action: "conflict.flagged",
      entity: "deal",
      entityId: dealId,
      detail: { buyer_company_id: h.buyer_company_id, kind: h.kind, other_deal_id: h.kind === "referral_firm" ? null : h.deal_id },
    });
  }
}

export type CompanyConflict = { sellerDeal: { id: number; label: string }; buyerDeal: { id: number; label: string; stage: string } };

/**
 * For the company page: this company is the seller on one open deal and a
 * live buyer (not declined, not removed) on another. Only deals this user can
 * see are considered, so the line never reveals a mandate behind a wall.
 */
export function companyConflicts(companyId: number, user: AccessUser): CompanyConflict[] {
  const closed = firm.closedStages as readonly string[];
  const ws = visibleDealIds(user, "d.id");
  const sells = db()
    .prepare(
      `SELECT d.id, d.code_name, d.title FROM deals d
       WHERE d.company_id = ? AND d.stage NOT IN (${placeholders(closed.length)}) AND ${ws.sql}`
    )
    .all(companyId, ...closed, ...ws.params) as { id: number; code_name: string | null; title: string }[];
  if (!sells.length) return [];
  const buys = db()
    .prepare(
      `SELECT d.id, d.code_name, d.title, b.stage FROM deal_buyers b
       JOIN deals d ON d.id = b.deal_id
       WHERE b.buyer_company_id = ? AND b.removed_at IS NULL AND b.stage NOT IN ('declined','closed')
         AND d.stage NOT IN (${placeholders(closed.length)}) AND ${ws.sql}`
    )
    .all(companyId, ...closed, ...ws.params) as { id: number; code_name: string | null; title: string; stage: string }[];
  const out: CompanyConflict[] = [];
  for (const s of sells)
    for (const b of buys)
      if (b.id !== s.id) out.push({ sellerDeal: { id: s.id, label: dealLabel(s) }, buyerDeal: { id: b.id, label: dealLabel(b), stage: b.stage } });
  return out;
}
