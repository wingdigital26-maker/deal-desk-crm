// Buyer log service: every read and write of deal_buyers goes through here so
// the routes stay thin and the 17a-4 rules live in one place:
//   - a stage move writes exactly one deal_buyer_stage_history row
//   - a milestone date is stamped the first time a stage is reached, never overwritten
//   - a term edit writes the old and new value to deal_buyer_revisions
//   - buyers are soft-removed, never deleted
import { db, audit } from "./db";
import * as v from "./validate";
import { BUYER_STAGES, FORWARD_STAGES, isBuyerStage, milestoneColumn, stageRank, type BuyerStage } from "./buyerStages";

export type BuyerRow = {
  id: number;
  deal_id: number;
  buyer_company_id: number;
  buyer_name: string;
  buyer_domain: string | null;
  buyer_type: string | null;
  lead_contact_id: number | null;
  lead_first_name: string | null;
  lead_last_name: string | null;
  stage: BuyerStage;
  declined_from_stage: string | null;
  decline_reason: string | null;
  ioi_low: number | null;
  ioi_high: number | null;
  loi_value: number | null;
  cash_at_close_pct: number | null;
  rollover_pct: number | null;
  earnout: string | null;
  financing: string | null;
  diligence_days: number | null;
  exclusivity_days: number | null;
  structure_notes: string | null;
  notes: string | null;
  updated_at: string;
  created_at: string;
} & Record<`${BuyerStage}_at`, string | null>;

export class BuyerError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const SELECT_BUYERS = `
  SELECT b.*, c.name AS buyer_name, c.domain AS buyer_domain, p.buyer_type,
         ct.first_name AS lead_first_name, ct.last_name AS lead_last_name
  FROM deal_buyers b
  JOIN companies c ON c.id = b.buyer_company_id
  LEFT JOIN buyer_profiles p ON p.company_id = b.buyer_company_id
  LEFT JOIN contacts ct ON ct.id = b.lead_contact_id`;

export function listBuyers(dealId: number): BuyerRow[] {
  return db()
    .prepare(`${SELECT_BUYERS} WHERE b.deal_id = ? AND b.removed_at IS NULL ORDER BY c.name COLLATE NOCASE`)
    .all(dealId) as BuyerRow[];
}

export function getBuyer(id: number): BuyerRow | undefined {
  return db().prepare(`${SELECT_BUYERS} WHERE b.id = ?`).get(id) as BuyerRow | undefined;
}

/** Current-stage counts; always all ten stages, zeros included, summing to the buyer total. */
export function funnel(rows: Pick<BuyerRow, "stage">[]): Record<BuyerStage, number> {
  const out = Object.fromEntries(BUYER_STAGES.map((s) => [s, 0])) as Record<BuyerStage, number>;
  for (const r of rows) out[r.stage] += 1;
  return out;
}

/**
 * How many buyers ever got at least as far as each forward stage (a buyer who
 * declined after the CIM still counts toward teaser, NDA and CIM). This is the
 * "40 teasers, 18 NDAs, 9 IOIs" line a seller report leads with.
 */
export function reached(rows: BuyerRow[]): Record<string, number> {
  const out = Object.fromEntries(FORWARD_STAGES.map((s) => [s, 0])) as Record<string, number>;
  for (const r of rows) {
    let max = r.stage === "declined" ? -1 : stageRank(r.stage);
    if (r.stage === "declined" && isBuyerStage(r.declined_from_stage)) max = Math.max(max, stageRank(r.declined_from_stage));
    for (const s of FORWARD_STAGES) if (r[`${s}_at`]) max = Math.max(max, stageRank(s));
    for (let i = 0; i <= max; i++) out[FORWARD_STAGES[i]] += 1;
  }
  return out;
}

function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export type AddResult = { created: number[]; restored: number[]; skipped: { buyer_company_id: number; reason: string }[] };

export function addBuyers(dealId: number, items: { buyer_company_id: number; lead_contact_id?: number | null }[], userId: number): AddResult {
  const d = db();
  if (!d.prepare("SELECT id FROM deals WHERE id = ?").get(dealId)) throw new BuyerError("Unknown deal", 404);
  const result: AddResult = { created: [], restored: [], skipped: [] };
  tx(() => {
    const seen = new Set<number>();
    for (const item of items) {
      const cid = item.buyer_company_id;
      if (seen.has(cid)) {
        result.skipped.push({ buyer_company_id: cid, reason: "Listed twice in this batch" });
        continue;
      }
      seen.add(cid);
      if (!d.prepare("SELECT id FROM companies WHERE id = ?").get(cid)) {
        result.skipped.push({ buyer_company_id: cid, reason: "Unknown company" });
        continue;
      }
      const existing = d.prepare("SELECT id, removed_at FROM deal_buyers WHERE deal_id = ? AND buyer_company_id = ?").get(dealId, cid) as
        | { id: number; removed_at: string | null }
        | undefined;
      if (existing && !existing.removed_at) {
        result.skipped.push({ buyer_company_id: cid, reason: "Already on this buyer log" });
        continue;
      }
      if (existing) {
        d.prepare("UPDATE deal_buyers SET removed_at = NULL, updated_at = datetime('now') WHERE id = ?").run(existing.id);
        d.prepare("INSERT INTO deal_buyer_revisions (deal_buyer_id, field, old_value, new_value, changed_by) VALUES (?, 'removed_at', ?, NULL, ?)").run(
          existing.id,
          existing.removed_at,
          userId
        );
        result.restored.push(existing.id);
        continue;
      }
      const id = Number(
        d
          .prepare(
            "INSERT INTO deal_buyers (deal_id, buyer_company_id, lead_contact_id, stage, teaser_sent_at, owner_user_id) VALUES (?, ?, ?, 'teaser_sent', datetime('now'), ?)"
          )
          .run(dealId, cid, item.lead_contact_id ?? null, userId).lastInsertRowid
      );
      d.prepare("INSERT INTO deal_buyer_stage_history (deal_buyer_id, from_stage, to_stage, changed_by) VALUES (?, NULL, 'teaser_sent', ?)").run(id, userId);
      result.created.push(id);
    }
  });
  audit({
    actorUserId: userId,
    action: "deal_buyer.add",
    entity: "deal",
    entityId: dealId,
    detail: { count: result.created.length, restored: result.restored.length, skipped: result.skipped.length, buyer_company_ids: items.map((i) => i.buyer_company_id) },
  });
  return result;
}

/** One stage move inside the caller's transaction. Returns false when nothing changed. */
function moveOne(id: number, to: BuyerStage, reason: string | null, note: string | null, userId: number): boolean {
  const d = db();
  const row = d.prepare("SELECT id, stage, decline_reason, removed_at FROM deal_buyers WHERE id = ?").get(id) as
    | { id: number; stage: BuyerStage; decline_reason: string | null; removed_at: string | null }
    | undefined;
  if (!row || row.removed_at) throw new BuyerError(`Buyer ${id} not found`, 404);
  if (row.stage === to) return false;
  const sets: string[] = ["stage = ?", "updated_at = datetime('now')"];
  const vals: (string | number | null)[] = [to];
  if (to === "declined") {
    const why = reason ?? row.decline_reason;
    if (!why) throw new BuyerError("A reason is required to mark a buyer declined");
    sets.push("declined_from_stage = ?", "decline_reason = ?");
    vals.push(row.stage, why);
    if (why !== row.decline_reason) {
      d.prepare("INSERT INTO deal_buyer_revisions (deal_buyer_id, field, old_value, new_value, changed_by) VALUES (?, 'decline_reason', ?, ?, ?)").run(
        id,
        row.decline_reason,
        why,
        userId
      );
    }
  } else if (row.stage === "declined") {
    // Back in the process: the history keeps the decline, the row stops carrying it.
    sets.push("declined_from_stage = NULL");
  }
  const col = milestoneColumn(to);
  sets.push(`${col} = COALESCE(${col}, datetime('now'))`);
  d.prepare(`UPDATE deal_buyers SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  d.prepare("INSERT INTO deal_buyer_stage_history (deal_buyer_id, from_stage, to_stage, note, changed_by) VALUES (?, ?, ?, ?, ?)").run(
    id,
    row.stage,
    to,
    note ?? (to === "declined" ? reason ?? row.decline_reason : null),
    userId
  );
  return true;
}

export function changeStage(ids: number[], to: BuyerStage, opts: { reason?: string | null; note?: string | null; userId: number }) {
  if (to === "declined" && ids.length > 1 && !opts.reason) throw new BuyerError("A reason is required to mark buyers declined");
  const moved = tx(() => ids.filter((id) => moveOne(id, to, opts.reason ?? null, opts.note ?? null, opts.userId)));
  const dealIds = ids.length
    ? (db()
        .prepare(`SELECT DISTINCT deal_id FROM deal_buyers WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as { deal_id: number }[])
    : [];
  audit({
    actorUserId: opts.userId,
    action: ids.length > 1 ? "deal_buyer.bulk_stage_change" : "deal_buyer.stage_change",
    entity: ids.length > 1 ? "deal" : "deal_buyer",
    entityId: ids.length > 1 ? dealIds[0]?.deal_id ?? null : ids[0],
    detail: { ids, moved, to_stage: to, reason: opts.reason ?? null },
  });
  return moved;
}

export const TERM_FIELDS = [
  "lead_contact_id",
  "ioi_low",
  "ioi_high",
  "loi_value",
  "cash_at_close_pct",
  "rollover_pct",
  "earnout",
  "financing",
  "diligence_days",
  "exclusivity_days",
  "structure_notes",
  "notes",
  "decline_reason",
] as const;
export type TermField = (typeof TERM_FIELDS)[number];

export function updateTerms(id: number, patch: Partial<Record<TermField, string | number | null>>, userId: number) {
  const d = db();
  const row = d.prepare("SELECT * FROM deal_buyers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row || row.removed_at) throw new BuyerError("Buyer not found", 404);
  const low = "ioi_low" in patch ? patch.ioi_low : row.ioi_low;
  const high = "ioi_high" in patch ? patch.ioi_high : row.ioi_high;
  if (low != null && high != null && Number(low) > Number(high)) throw new BuyerError("IOI low cannot be above IOI high");
  if ("decline_reason" in patch && !patch.decline_reason && row.stage === "declined") {
    throw new BuyerError("A declined buyer must keep a reason");
  }
  const changed = (Object.keys(patch) as TermField[]).filter((k) => (row[k] ?? null) !== (patch[k] ?? null));
  if (!changed.length) return [];
  tx(() => {
    for (const k of changed) {
      d.prepare("INSERT INTO deal_buyer_revisions (deal_buyer_id, field, old_value, new_value, changed_by) VALUES (?, ?, ?, ?, ?)").run(
        id,
        k,
        row[k] == null ? null : String(row[k]),
        patch[k] == null ? null : String(patch[k]),
        userId
      );
    }
    d.prepare(`UPDATE deal_buyers SET ${changed.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(
      ...changed.map((k) => patch[k] ?? null),
      id
    );
  });
  audit({ actorUserId: userId, action: "deal_buyer.update", entity: "deal_buyer", entityId: id, detail: { fields: changed } });
  return changed;
}

export function removeBuyer(id: number, userId: number) {
  const d = db();
  const row = d.prepare("SELECT id, deal_id, removed_at FROM deal_buyers WHERE id = ?").get(id) as
    | { id: number; deal_id: number; removed_at: string | null }
    | undefined;
  if (!row || row.removed_at) throw new BuyerError("Buyer not found", 404);
  tx(() => {
    d.prepare("UPDATE deal_buyers SET removed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
    d.prepare("INSERT INTO deal_buyer_revisions (deal_buyer_id, field, old_value, new_value, changed_by) VALUES (?, 'removed_at', NULL, datetime('now'), ?)").run(
      id,
      userId
    );
  });
  audit({ actorUserId: userId, action: "deal_buyer.remove", entity: "deal_buyer", entityId: id, detail: { deal_id: row.deal_id } });
}

export type BuyerHistoryRow = {
  id: number;
  deal_id: number;
  deal_title: string;
  seller_name: string;
  deal_stage: string;
  stage: BuyerStage;
  declined_from_stage: string | null;
  decline_reason: string | null;
  ioi_low: number | null;
  ioi_high: number | null;
  loi_value: number | null;
  updated_at: string;
};

/** Every deal this company has been shown as a buyer, newest first (cross-deal buyer memory). */
export function buyerHistory(companyId: number): BuyerHistoryRow[] {
  return db()
    .prepare(
      `SELECT b.id, b.deal_id, d.title AS deal_title, s.name AS seller_name, d.stage AS deal_stage, b.stage,
              b.declined_from_stage, b.decline_reason, b.ioi_low, b.ioi_high, b.loi_value, b.updated_at
       FROM deal_buyers b JOIN deals d ON d.id = b.deal_id JOIN companies s ON s.id = d.company_id
       WHERE b.buyer_company_id = ? AND b.removed_at IS NULL
       ORDER BY b.updated_at DESC, b.id DESC`
    )
    .all(companyId) as BuyerHistoryRow[];
}

export type Candidate = { id: number; name: string; domain: string | null; buyer_type: string | null; times_shown: number };

/**
 * Companies to offer in the bulk-add picker, excluding ones already on this
 * deal. With no query: known buyers (a profile, or shown on an earlier deal),
 * most-shown first. With a query: name or domain match.
 */
export function buyerCandidates(dealId: number, q: string, limit = 50): Candidate[] {
  const base = `SELECT c.id, c.name, c.domain, p.buyer_type,
       (SELECT COUNT(*) FROM deal_buyers x WHERE x.buyer_company_id = c.id AND x.removed_at IS NULL) AS times_shown
     FROM companies c LEFT JOIN buyer_profiles p ON p.company_id = c.id
     WHERE c.id NOT IN (SELECT buyer_company_id FROM deal_buyers WHERE deal_id = ? AND removed_at IS NULL)
       AND c.id != (SELECT company_id FROM deals WHERE id = ?)`;
  if (q) {
    return db()
      .prepare(`${base} AND (c.name LIKE ? OR c.domain LIKE ?) ORDER BY (p.company_id IS NULL), c.name COLLATE NOCASE LIMIT ?`)
      .all(dealId, dealId, `%${q}%`, `%${q}%`, limit) as Candidate[];
  }
  return db()
    .prepare(`${base} AND (p.company_id IS NOT NULL OR EXISTS (SELECT 1 FROM deal_buyers y WHERE y.buyer_company_id = c.id)) ORDER BY times_shown DESC, c.name COLLATE NOCASE LIMIT ?`)
    .all(dealId, dealId, limit) as Candidate[];
}

const normDomain = (s: string) =>
  s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/**
 * Matches pasted CSV rows to existing companies: by domain first, then exact
 * name (case-insensitive). Unmatched rows come back as null for the banker to
 * resolve; a buyer list never silently creates companies.
 */
export function resolveCompanies(rows: { name?: string; domain?: string }[]) {
  const byDomain = db().prepare("SELECT id, name, domain FROM companies WHERE domain = ?");
  const byName = db().prepare("SELECT id, name, domain FROM companies WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 2");
  return rows.map((r) => {
    const domain = r.domain ? normDomain(r.domain) : "";
    let match = domain ? (byDomain.get(domain) as { id: number; name: string; domain: string | null } | undefined) : undefined;
    let ambiguous = false;
    if (!match && r.name?.trim()) {
      const hits = byName.all(r.name.trim()) as { id: number; name: string; domain: string | null }[];
      ambiguous = hits.length > 1;
      match = hits.length === 1 ? hits[0] : undefined;
    }
    return { input: { name: r.name ?? "", domain: r.domain ?? "" }, match: match ?? null, ambiguous };
  });
}

/** Validates the term keys present in a request body. Unknown keys are ignored. */
export function parseTermPatch(body: Record<string, unknown>): Partial<Record<TermField, string | number | null>> {
  const out: Partial<Record<TermField, string | number | null>> = {};
  const has = (k: string) => k in body;
  if (has("lead_contact_id")) out.lead_contact_id = v.integerRange("lead_contact_id", body.lead_contact_id, 1, Number.MAX_SAFE_INTEGER);
  for (const k of ["ioi_low", "ioi_high", "loi_value"] as const) if (has(k)) out[k] = v.money(k, body[k]);
  for (const k of ["cash_at_close_pct", "rollover_pct"] as const) if (has(k)) out[k] = v.percent(k, body[k]);
  for (const k of ["diligence_days", "exclusivity_days"] as const) if (has(k)) out[k] = v.integerRange(k, body[k], 0, 3650);
  for (const k of ["earnout", "financing"] as const) if (has(k)) out[k] = v.boundedString(k, body[k], 500);
  for (const k of ["structure_notes", "notes"] as const) if (has(k)) out[k] = v.boundedString(k, body[k], 2000);
  return out;
}

/** BuyerError and ValidationError become the usual { error } JSON; anything else is rethrown. */
export function buyerErrorResponse(err: unknown): Response {
  if (err instanceof BuyerError) return Response.json({ error: err.message }, { status: err.status });
  const res = v.validationErrorResponse(err);
  if (res) return res;
  throw err;
}

export function stageHistory(dealId: number) {
  return db()
    .prepare(
      `SELECT h.id, h.deal_buyer_id, h.from_stage, h.to_stage, h.note, h.created_at, u.name AS user_name, c.name AS buyer_name
       FROM deal_buyer_stage_history h
       JOIN deal_buyers b ON b.id = h.deal_buyer_id
       JOIN companies c ON c.id = b.buyer_company_id
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE b.deal_id = ? ORDER BY h.created_at DESC, h.id DESC`
    )
    .all(dealId) as { id: number; deal_buyer_id: number; from_stage: string | null; to_stage: string; note: string | null; created_at: string; user_name: string | null; buyer_name: string }[];
}
