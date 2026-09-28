// Need-to-know deal access (information barriers for MNPI, Exchange Act 15(g)).
// An unannounced mandate, its buyer list, bids and documents are material
// non-public information, so with firm.dealAccess = "team" a user sees and acts
// on a deal only when they own it (deals.owner_user_id) or sit on its deal_team.
// Owners administer the desk and see every deal; each time an owner opens a deal
// they are not on, the page writes a `deal.view.outside_team` audit row so wall
// crossings are on the record. With "all", everyone sees everything.
//
// Every read or write of a deal, or of anything hanging off one (buyers,
// documents, tasks, timeline, regulatory, reports, exports, search), goes
// through these helpers. A deal the user cannot see answers 404, never 403, so
// its existence does not leak.
import { db, audit } from "./db";
import { firm } from "../../firm.config";

export type AccessUser = { id: number; role: string };
export type DealAccessMode = "team" | "all";

export const dealAccessMode = (): DealAccessMode => firm.dealAccess;

/** True when this user sees every deal (access mode "all", or an owner). */
export function seesAllDeals(user: AccessUser): boolean {
  return dealAccessMode() === "all" || user.role === "owner";
}

/**
 * A SQL condition restricting `column` (a deal id) to deals this user can see,
 * with its bound parameters. Always a prepared-statement fragment, never
 * interpolated values. `nullable` lets rows with no deal through (a company
 * timeline note, a task with no deal).
 */
export function visibleDealIds(user: AccessUser, column = "d.id", opts: { nullable?: boolean } = {}): { sql: string; params: number[] } {
  if (seesAllDeals(user)) return { sql: "1 = 1", params: [] };
  const inList = `${column} IN (SELECT id FROM deals WHERE owner_user_id = ? UNION SELECT deal_id FROM deal_team WHERE user_id = ?)`;
  return { sql: opts.nullable ? `(${column} IS NULL OR ${inList})` : inList, params: [user.id, user.id] };
}

/** Whether the deal exists and this user can see it. */
export function canSeeDeal(user: AccessUser, dealId: number): boolean {
  if (!Number.isInteger(dealId) || dealId <= 0) return false;
  if (seesAllDeals(user)) return !!db().prepare("SELECT 1 FROM deals WHERE id = ?").get(dealId);
  return !!db()
    .prepare(
      `SELECT 1 FROM deals d WHERE d.id = ?
         AND (d.owner_user_id = ? OR EXISTS (SELECT 1 FROM deal_team t WHERE t.deal_id = d.id AND t.user_id = ?))`
    )
    .get(dealId, user.id, user.id);
}

/** null when visible, else the 404 to return (same body as a missing deal). */
export function assertDeal(user: AccessUser, dealId: number): Response | null {
  return canSeeDeal(user, dealId) ? null : Response.json({ error: "Not found" }, { status: 404 });
}

/** The ids of every deal this user can see (for filtering computed lists). */
export function visibleDealIdSet(user: AccessUser): Set<number> {
  const w = visibleDealIds(user, "id");
  const rows = db().prepare(`SELECT id FROM deals WHERE ${w.sql}`).all(...w.params) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

/** How many deals a user can see, for the People admin screen. */
export function visibleDealCount(user: AccessUser): number {
  const w = visibleDealIds(user, "id");
  return (db().prepare(`SELECT COUNT(*) AS n FROM deals WHERE ${w.sql}`).get(...w.params) as { n: number }).n;
}

/** The deal a buyer-log row belongs to, or null. */
export function dealIdForBuyer(dealBuyerId: number): number | null {
  const r = db().prepare("SELECT deal_id FROM deal_buyers WHERE id = ?").get(dealBuyerId) as { deal_id: number } | undefined;
  return r?.deal_id ?? null;
}

/** The deal a document version belongs to, or null. */
export function dealIdForDocument(documentId: number): number | null {
  const r = db().prepare("SELECT deal_id FROM documents WHERE id = ?").get(documentId) as { deal_id: number } | undefined;
  return r?.deal_id ?? null;
}

/** The deal a task belongs to: undefined when the task is missing, null when it has no deal. */
export function dealIdForTask(taskId: number): number | null | undefined {
  const r = db().prepare("SELECT deal_id FROM tasks WHERE id = ?").get(taskId) as { deal_id: number | null } | undefined;
  return r === undefined ? undefined : r.deal_id;
}

/** Whether the user is on the team (or owns the deal), ignoring the owner-role override. */
export function isOnDeal(user: AccessUser, dealId: number): boolean {
  return !!db()
    .prepare(
      `SELECT 1 FROM deals d WHERE d.id = ?
         AND (d.owner_user_id = ? OR EXISTS (SELECT 1 FROM deal_team t WHERE t.deal_id = d.id AND t.user_id = ?))`
    )
    .get(dealId, user.id, user.id);
}

/** Creating a deal puts its creator on the team as lead, so the wall never locks them out. */
export function addCreatorToTeam(dealId: number, userId: number) {
  db().prepare("INSERT OR IGNORE INTO deal_team (deal_id, user_id, role) VALUES (?, ?, 'lead')").run(dealId, userId);
}

/**
 * An owner opening a deal they are not on is allowed (they run the desk) and
 * recorded, so a compliance review can see every wall crossing.
 */
export function recordOutsideTeamView(user: AccessUser, dealId: number, where: string) {
  if (dealAccessMode() !== "team" || user.role !== "owner" || isOnDeal(user, dealId)) return;
  // One row per owner, deal and hour: a page refresh is not a second crossing.
  const recent = db()
    .prepare(
      `SELECT 1 FROM audit_log WHERE action = 'deal.view.outside_team' AND actor_user_id = ? AND entity_id = ?
         AND created_at >= datetime('now', '-1 hour') LIMIT 1`
    )
    .get(user.id, dealId);
  if (recent) return;
  audit({ actorUserId: user.id, action: "deal.view.outside_team", entity: "deal", entityId: dealId, detail: { where } });
}
