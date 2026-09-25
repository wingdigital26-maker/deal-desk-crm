// Deal economics: pure functions, no database, shared by the pipeline header,
// the deal page and the tests. Dollars are whole numbers; percentages and
// probabilities are 0-100.
//
// Expected fee = retainer + enterprise value x success fee %.
// Weighted fee = expected fee x probability. A deal with no probability of its
// own uses the stage default from firm.config.ts, and says so.

export type DealMoney = {
  stage: string;
  retainer?: number | null;
  success_fee_pct?: number | null;
  enterprise_value?: number | null;
  probability?: number | null;
  expected_close?: string | null;
};

export type StageDefaults = { stageProbability: Record<string, number>; closedStages: readonly string[] };

/** Retainer plus success fee. Null when the deal carries no fee inputs at all. */
export function expectedFee(d: DealMoney): number | null {
  const hasSuccess = d.enterprise_value != null && d.success_fee_pct != null;
  if (d.retainer == null && !hasSuccess) return null;
  const success = hasSuccess ? Math.round((d.enterprise_value! * d.success_fee_pct!) / 100) : 0;
  return (d.retainer ?? 0) + success;
}

export function effectiveProbability(d: DealMoney, cfg: StageDefaults): { value: number; source: "deal" | "stage" } {
  if (d.probability != null) return { value: d.probability, source: "deal" };
  return { value: cfg.stageProbability[d.stage] ?? 0, source: "stage" };
}

export function weightedFee(d: DealMoney, cfg: StageDefaults): number | null {
  const fee = expectedFee(d);
  if (fee == null) return null;
  return Math.round((fee * effectiveProbability(d, cfg).value) / 100);
}

export const isOpenStage = (stage: string, cfg: StageDefaults) => !cfg.closedStages.includes(stage);

/** "2026 Q4" for an ISO date, or null. */
export function quarterOf(iso: string | null | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}/.test(iso)) return null;
  const month = Number(iso.slice(5, 7));
  return `${iso.slice(0, 4)} Q${Math.ceil(month / 3)}`;
}

export type PipelineSummary = {
  openCount: number;
  withFeeCount: number;          // open deals that carry fee inputs
  totalEnterpriseValue: number;
  expectedFees: number;
  weightedFees: number;
  stageDefaultCount: number;     // open deals weighted by a stage default, not their own probability
  byQuarter: { quarter: string; count: number; expected: number; weighted: number }[];
  noCloseDateWeighted: number;
};

export function pipelineSummary(deals: DealMoney[], cfg: StageDefaults): PipelineSummary {
  const open = deals.filter((d) => isOpenStage(d.stage, cfg));
  const q = new Map<string, { quarter: string; count: number; expected: number; weighted: number }>();
  const out: PipelineSummary = {
    openCount: open.length,
    withFeeCount: 0,
    totalEnterpriseValue: 0,
    expectedFees: 0,
    weightedFees: 0,
    stageDefaultCount: 0,
    byQuarter: [],
    noCloseDateWeighted: 0,
  };
  for (const d of open) {
    out.totalEnterpriseValue += d.enterprise_value ?? 0;
    const fee = expectedFee(d);
    if (fee == null) continue;
    const w = weightedFee(d, cfg) ?? 0;
    out.withFeeCount += 1;
    out.expectedFees += fee;
    out.weightedFees += w;
    if (effectiveProbability(d, cfg).source === "stage") out.stageDefaultCount += 1;
    const quarter = quarterOf(d.expected_close);
    if (!quarter) {
      out.noCloseDateWeighted += w;
      continue;
    }
    const row = q.get(quarter) ?? { quarter, count: 0, expected: 0, weighted: 0 };
    row.count += 1;
    row.expected += fee;
    row.weighted += w;
    q.set(quarter, row);
  }
  out.byQuarter = [...q.values()].sort((a, b) => a.quarter.localeCompare(b.quarter));
  return out;
}

/**
 * EV and EBITDA are linked by the multiple: EV = EBITDA x multiple. The deal
 * page keeps all three in step, so changing EBITDA reprices EV (and every fee
 * that hangs off EV) at the same multiple.
 */
export function evFromMultiple(ebitda: number | null, multiple: number | null): number | null {
  if (ebitda == null || multiple == null || Number.isNaN(ebitda) || Number.isNaN(multiple) || multiple <= 0) return null;
  return Math.round(ebitda * multiple);
}

/** EV / EBITDA to two decimals, or null when either side is missing or EBITDA is not positive. */
export function multipleOf(ev: number | null, ebitda: number | null): number | null {
  if (ev == null || ebitda == null || Number.isNaN(ev) || Number.isNaN(ebitda) || ebitda <= 0) return null;
  return Math.round((ev / ebitda) * 100) / 100;
}

/** "$12.5M", "$750K", "$1,200". Null prints as an empty string; the caller picks the placeholder. */
export function formatMoney(n: number | null | undefined): string {
  if (n == null) return "";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${trim(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}$${trim(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}$${trim(abs / 1_000)}K`;
  return `${sign}$${abs.toLocaleString("en-US")}`;
}

function trim(x: number): string {
  return x >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, "");
}

/**
 * Bankers type money the way they say it: "12.5M", "$750k", "1,200,000", "2b".
 * Returns whole dollars, null for blank, or NaN for something unreadable.
 */
export function parseMoney(input: string): number | null {
  const s = input.trim().replace(/[$,\s]/g, "").toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m|mm|b|bn)?$/);
  if (!m) return NaN;
  const mult = m[2] === "k" ? 1e3 : m[2] === "m" || m[2] === "mm" ? 1e6 : m[2] === "b" || m[2] === "bn" ? 1e9 : 1;
  return Math.round(Number(m[1]) * mult);
}
