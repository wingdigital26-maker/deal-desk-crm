// P5 BANK / FIG: every read and write of the regulatory tracker goes through
// here so the route stays thin. These are working trackers, not books and
// records: rows can be deleted, but every add, edit and delete is audited, and
// a delete keeps the full old row in the audit detail.
import { db, audit } from "./db";
import * as v from "./validate";
import {
  FILING_DATE_FIELDS,
  FILING_STATUSES,
  REGULATORS,
  VOTE_DATE_FIELDS,
  VOTE_PARTIES,
  VOTE_RESULTS,
  orderingError,
  suggestions,
  type Filing,
  type ShareholderVote,
  type Suggestions,
} from "./regulatory";

export class RegulatoryError extends Error {
  status: number;
  field?: string;
  constructor(message: string, status = 400, field?: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

export type RegulatoryState = {
  fig_track: number;
  filings: (Filing & { suggestions: Suggestions })[];
  votes: ShareholderVote[];
};

const REG_ORDER = `CASE regulator WHEN 'FDIC' THEN 0 WHEN 'OCC' THEN 1 WHEN 'FED' THEN 2 WHEN 'STATE' THEN 3 ELSE 4 END`;

export function listFilings(dealId: number): Filing[] {
  return db().prepare(`SELECT * FROM deal_regulatory_filings WHERE deal_id = ? ORDER BY ${REG_ORDER}, agency_label, id`).all(dealId) as Filing[];
}

export function listVotes(dealId: number): ShareholderVote[] {
  return db()
    .prepare("SELECT * FROM deal_shareholder_votes WHERE deal_id = ? ORDER BY CASE party WHEN 'target' THEN 0 ELSE 1 END")
    .all(dealId) as ShareholderVote[];
}

export function regulatoryState(dealId: number): RegulatoryState | null {
  const deal = db().prepare("SELECT fig_track FROM deals WHERE id = ?").get(dealId) as { fig_track: number } | undefined;
  if (!deal) return null;
  return {
    fig_track: deal.fig_track,
    filings: listFilings(dealId).map((f) => ({ ...f, suggestions: suggestions(f) })),
    votes: listVotes(dealId),
  };
}

// ---- validation ----

type Row = Record<string, string | number | null>;

function cleanFiling(body: Record<string, unknown>, partial: boolean): Row {
  const out: Row = {};
  if (!partial || "regulator" in body) out.regulator = v.enumFromList("regulator", body.regulator, REGULATORS, { required: true });
  if ("agency_label" in body) out.agency_label = v.boundedString("agency_label", body.agency_label, 200);
  for (const f of FILING_DATE_FIELDS) if (f in body) out[f] = v.isoDate(f, body[f]);
  if ("status" in body) out.status = v.enumFromList("status", body.status, FILING_STATUSES, { required: true });
  if ("doj_concurrence" in body) {
    const raw = body.doj_concurrence;
    out.doj_concurrence = raw === true ? 1 : raw === false ? 0 : v.integerRange("doj_concurrence", raw, 0, 1, { required: true });
  }
  if ("notes" in body) out.notes = v.notes("notes", body.notes);
  return out;
}

function cleanVote(body: Record<string, unknown>, partial: boolean): Row {
  const out: Row = {};
  if (!partial || "party" in body) out.party = v.enumFromList("party", body.party, VOTE_PARTIES, { required: true });
  for (const f of VOTE_DATE_FIELDS) if (f in body) out[f] = v.isoDate(f, body[f]);
  if ("result" in body) out.result = v.enumFromList("result", body.result, VOTE_RESULTS, { fallback: "pending" });
  if ("votes_for_pct" in body) out.votes_for_pct = v.percent("votes_for_pct", body.votes_for_pct);
  if ("notes" in body) out.notes = v.notes("notes", body.notes);
  return out;
}

function checkOrder(merged: Row) {
  const err = orderingError(merged as Record<string, string | null>);
  if (err) throw new RegulatoryError(err.message, 400, err.field);
}

function requireDeal(dealId: number) {
  if (!db().prepare("SELECT id FROM deals WHERE id = ?").get(dealId)) throw new RegulatoryError("Not found", 404);
}

function duplicateFiling(dealId: number, regulator: unknown, label: unknown, exceptId = 0): boolean {
  // NULL labels count as equal here, so the same regulator with no label cannot be added twice.
  return !!db()
    .prepare(
      "SELECT 1 FROM deal_regulatory_filings WHERE deal_id = ? AND regulator = ? AND IFNULL(agency_label, '') = IFNULL(?, '') AND id != ?"
    )
    .get(dealId, regulator as string, (label as string | null) ?? null, exceptId);
}

function insert(table: string, row: Row): number {
  const cols = Object.keys(row);
  return Number(
    db()
      .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...Object.values(row)).lastInsertRowid
  );
}

// ---- writes ----

export function addEntry(dealId: number, body: Record<string, unknown>, userId: number): number {
  requireDeal(dealId);
  if (body.type === "filing") {
    const row = cleanFiling(body, false);
    checkOrder(row);
    if (duplicateFiling(dealId, row.regulator, row.agency_label ?? null)) {
      throw new RegulatoryError("This regulator is already tracked on this deal. Give it a different agency name to add another.", 409, "agency_label");
    }
    const id = insert("deal_regulatory_filings", { deal_id: dealId, ...row });
    audit({ actorUserId: userId, action: "deal.regulatory.filing.add", entity: "deal", entityId: dealId, detail: { filing_id: id, ...row } });
    return id;
  }
  if (body.type === "vote") {
    const row = cleanVote(body, false);
    if (db().prepare("SELECT 1 FROM deal_shareholder_votes WHERE deal_id = ? AND party = ?").get(dealId, row.party)) {
      throw new RegulatoryError(`A ${row.party} shareholder vote is already tracked on this deal.`, 409, "party");
    }
    const id = insert("deal_shareholder_votes", { deal_id: dealId, ...row });
    audit({ actorUserId: userId, action: "deal.regulatory.vote.add", entity: "deal", entityId: dealId, detail: { vote_id: id, ...row } });
    return id;
  }
  throw new RegulatoryError("type must be filing or vote", 400, "type");
}

function tableFor(type: unknown): { table: string; kind: "filing" | "vote" } {
  if (type === "filing") return { table: "deal_regulatory_filings", kind: "filing" };
  if (type === "vote") return { table: "deal_shareholder_votes", kind: "vote" };
  throw new RegulatoryError("type must be filing or vote", 400, "type");
}

function existingRow(table: string, dealId: number, rawId: unknown): Row {
  const id = v.integerRange("id", rawId, 1, Number.MAX_SAFE_INTEGER, { required: true })!;
  const row = db().prepare(`SELECT * FROM ${table} WHERE id = ? AND deal_id = ?`).get(id, dealId) as Row | undefined;
  if (!row) throw new RegulatoryError("Not found", 404);
  return row;
}

export function updateEntry(dealId: number, body: Record<string, unknown>, userId: number): void {
  requireDeal(dealId);
  const { table, kind } = tableFor(body.type);
  const old = existingRow(table, dealId, body.id);
  const patch = kind === "filing" ? cleanFiling(body, true) : cleanVote(body, true);
  const merged = { ...old, ...patch };
  if (kind === "filing") {
    checkOrder(merged);
    if (("regulator" in patch || "agency_label" in patch) && duplicateFiling(dealId, merged.regulator, merged.agency_label, Number(old.id))) {
      throw new RegulatoryError("This regulator is already tracked on this deal.", 409, "agency_label");
    }
  } else if ("party" in patch && patch.party !== old.party) {
    if (db().prepare("SELECT 1 FROM deal_shareholder_votes WHERE deal_id = ? AND party = ? AND id != ?").get(dealId, patch.party, old.id)) {
      throw new RegulatoryError(`A ${patch.party} shareholder vote is already tracked on this deal.`, 409, "party");
    }
  }
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, val] of Object.entries(patch)) if (old[k] !== val) changes[k] = { from: old[k], to: val };
  if (Object.keys(changes).length === 0) return;
  const cols = Object.keys(changes);
  db()
    .prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .run(...cols.map((c) => patch[c]), old.id);
  audit({
    actorUserId: userId,
    action: `deal.regulatory.${kind}.update`,
    entity: "deal",
    entityId: dealId,
    detail: { [`${kind}_id`]: old.id, changes },
  });
}

export function deleteEntry(dealId: number, type: unknown, rawId: unknown, userId: number): void {
  requireDeal(dealId);
  const { table, kind } = tableFor(type);
  const old = existingRow(table, dealId, rawId);
  db().prepare(`DELETE FROM ${table} WHERE id = ?`).run(old.id);
  audit({ actorUserId: userId, action: `deal.regulatory.${kind}.delete`, entity: "deal", entityId: dealId, detail: { old } });
}
