// Daily spend guard for Apollo enrichment credits. Enrichment is the only
// thing in this app that spends real money, so every attempt is checked
// against a daily cap read from today's audit_log rows before any Apollo
// call is made. The core (checkDailySpend) is a pure function so it is
// unit-testable without a database; spendGuard is the thin wiring used by
// the enrich route.
import type { DatabaseSync } from "node:sqlite";

export function defaultDailyCap(): number {
  const raw = process.env.APOLLO_DAILY_CREDIT_CAP;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}

export type SpendCheck =
  | { ok: true; spentToday: number; cap: number }
  | { ok: false; reason: string; spentToday: number; cap: number };

// Pure core: given what has already been spent today and what this call
// would add, decide whether it is allowed.
export function checkDailySpend(spentToday: number, requested: number, cap: number): SpendCheck {
  if (requested <= 0) return { ok: true, spentToday, cap };
  if (spentToday + requested > cap) {
    return {
      ok: false,
      reason: `This would use ${spentToday + requested} Apollo credits today, above the daily cap of ${cap}. Raise APOLLO_DAILY_CREDIT_CAP or try again tomorrow.`,
      spentToday,
      cap,
    };
  }
  return { ok: true, spentToday, cap };
}

// Sums the creditsUsed field out of every apollo.enrich audit row recorded
// today. Kept separate from checkDailySpend so the summing logic itself is
// also directly testable against a plain array of rows.
export function sumCreditsFromAuditRows(rows: { detail_json: string }[]): number {
  return rows.reduce((sum, r) => {
    try {
      const detail = JSON.parse(r.detail_json || "{}") as { creditsUsed?: unknown };
      return sum + (typeof detail.creditsUsed === "number" && Number.isFinite(detail.creditsUsed) ? detail.creditsUsed : 0);
    } catch {
      return sum;
    }
  }, 0);
}

type DBLike = Pick<DatabaseSync, "prepare">;

// Reads today's Apollo enrich spend from audit_log and checks it against the
// configured daily cap.
export function spendGuard(db: DBLike, requestedCredits: number): SpendCheck {
  const cap = defaultDailyCap();
  const rows = db
    .prepare(`SELECT detail_json FROM audit_log WHERE action = 'apollo.enrich' AND date(created_at) = date('now')`)
    .all() as { detail_json: string }[];
  const spentToday = sumCreditsFromAuditRows(rows);
  return checkDailySpend(spentToday, requestedCredits, cap);
}
