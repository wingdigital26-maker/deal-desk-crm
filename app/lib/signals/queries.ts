// Read/write helpers for the signal-sourcing lane (companies.signal_score,
// signals table, and the discover-to-deal promotion). Pure data access; API
// routes handle auth and validation.
import { db, audit } from "../db";
import { firm } from "../../../firm.config";

type SQLInputValue = string | number | bigint | null | Uint8Array;

export type SignalRow = {
  id: number;
  company_id: number;
  kind: string;
  title: string;
  url: string | null;
  observed_at: string | null;
  weight: number;
  created_at: string;
};

export type CompanyWithSignals = {
  id: number;
  name: string;
  domain: string | null;
  segment_id: string;
  city: string | null;
  state: string | null;
  source: string;
  signal_score: number;
  created_at: string;
  /** The company's open deal (any stage but Passed), so the table can link to
   * it instead of offering a "Create deal" that would only answer 409. */
  open_deal_id: number | null;
  signals: SignalRow[];
};

export type SignalsFilter = {
  kind?: string;
  segment?: string;
  minScore?: number;
  since?: string; // ISO date; filters on signals.observed_at (falls back to created_at)
};

const VALID_KINDS = new Set(["hiring", "news", "filing", "contract", "recall", "other"]);

export function isValidKind(kind: string): boolean {
  return VALID_KINDS.has(kind);
}

export function isValidSegment(segmentId: string): boolean {
  return firm.segments.some((s) => s.id === segmentId);
}

/** Ranked companies with their top signals, honoring filters. */
export function listRankedCompanies(filter: SignalsFilter, topSignalsPerCompany = 3): CompanyWithSignals[] {
  const conditions: string[] = ["1=1"];
  const params: SQLInputValue[] = [];

  if (filter.segment && isValidSegment(filter.segment)) {
    conditions.push("c.segment_id = ?");
    params.push(filter.segment);
  }
  if (typeof filter.minScore === "number" && !Number.isNaN(filter.minScore)) {
    conditions.push("c.signal_score >= ?");
    params.push(filter.minScore);
  }

  let havingSignalKind = "";
  if (filter.kind && isValidKind(filter.kind)) {
    havingSignalKind = "AND EXISTS (SELECT 1 FROM signals s2 WHERE s2.company_id = c.id AND s2.kind = ?)";
    params.push(filter.kind);
  }
  let sinceClause = "";
  if (filter.since) {
    sinceClause = "AND EXISTS (SELECT 1 FROM signals s3 WHERE s3.company_id = c.id AND COALESCE(s3.observed_at, s3.created_at) >= ?)";
    params.push(filter.since);
  }

  // Query 1 of 2: the ranked companies themselves.
  const companies = db()
    .prepare(
      `SELECT c.id, c.name, c.domain, c.segment_id, c.city, c.state, c.source, c.signal_score, c.created_at,
              (SELECT d.id FROM deals d WHERE d.company_id = c.id AND d.stage != 'Passed' ORDER BY d.id DESC LIMIT 1) AS open_deal_id
       FROM companies c
       WHERE ${conditions.join(" AND ")} ${havingSignalKind} ${sinceClause}
       AND EXISTS (SELECT 1 FROM signals s WHERE s.company_id = c.id)
       ORDER BY c.signal_score DESC
       LIMIT 200`
    )
    .all(...params) as Omit<CompanyWithSignals, "signals">[];

  if (companies.length === 0) return [];

  // Query 2 of 2: every company's top N signals in one round trip, ranked
  // per-company with a window function instead of one query per company.
  const signalConditions: string[] = ["company_id IN (SELECT value FROM json_each(?))"];
  const signalParams: SQLInputValue[] = [JSON.stringify(companies.map((c) => c.id))];
  if (filter.kind && isValidKind(filter.kind)) {
    signalConditions.push("kind = ?");
    signalParams.push(filter.kind);
  }
  if (filter.since) {
    signalConditions.push("COALESCE(observed_at, created_at) >= ?");
    signalParams.push(filter.since);
  }
  signalParams.push(topSignalsPerCompany);

  const rankedSignals = db()
    .prepare(
      `WITH ranked AS (
         SELECT id, company_id, kind, title, url, observed_at, weight, created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY company_id
                  ORDER BY weight DESC, COALESCE(observed_at, created_at) DESC
                ) AS rn
         FROM signals
         WHERE ${signalConditions.join(" AND ")}
       )
       SELECT id, company_id, kind, title, url, observed_at, weight, created_at
       FROM ranked WHERE rn <= ?`
    )
    .all(...signalParams) as SignalRow[];

  const byCompany = new Map<number, SignalRow[]>();
  for (const s of rankedSignals) {
    const list = byCompany.get(s.company_id) ?? [];
    list.push(s);
    byCompany.set(s.company_id, list);
  }

  return companies.map((c) => ({ ...c, signals: byCompany.get(c.id) ?? [] }));
}

export function countCompaniesBySource(): Record<string, number> {
  const rows = db().prepare("SELECT source, COUNT(*) AS n FROM companies GROUP BY source").all() as {
    source: string;
    n: number;
  }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.source] = r.n;
  return out;
}

export function countCompaniesWithSignals(): number {
  const row = db()
    .prepare("SELECT COUNT(DISTINCT company_id) AS n FROM signals")
    .get() as { n: number };
  return row.n;
}

export function promoteCompanyToDeal(
  companyId: number,
  userId: number,
  opts: { title?: string; primaryContactId?: number | null } = {}
): { dealId: number } | { error: string; status: number } {
  const company = db().prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId) as
    | { id: number; name: string }
    | undefined;
  if (!company) return { error: "Unknown company_id", status: 400 };

  const existing = db()
    .prepare("SELECT id FROM deals WHERE company_id = ? AND stage != 'Passed' LIMIT 1")
    .get(companyId);
  if (existing) return { error: "This company already has an open deal", status: 409 };

  const stage = firm.dealStages[0]; // "Sourced"
  const title = opts.title?.trim() || `${company.name}: sourcing`;

  const result = db()
    .prepare(
      `INSERT INTO deals (company_id, primary_contact_id, title, stage) VALUES (?,?,?,?)`
    )
    .run(companyId, opts.primaryContactId ?? null, title, stage);

  const dealId = Number(result.lastInsertRowid);

  db()
    .prepare(
      `INSERT INTO activities (kind, body, company_id, deal_id, user_id) VALUES ('signal', ?, ?, ?, ?)`
    )
    .run(`Promoted from signal sourcing into stage ${stage}`, companyId, dealId, userId);

  audit({
    actorUserId: userId,
    action: "signals.promote",
    entity: "deal",
    entityId: dealId,
    detail: { company_id: companyId, stage },
  });

  return { dealId };
}
