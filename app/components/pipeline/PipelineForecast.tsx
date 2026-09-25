"use client";
// Pipeline value and fee forecast header. Every number is summed from real
// deal fields by app/lib/dealMath.ts; deals with no fee inputs are counted
// and named as missing, never estimated.
import { formatMoney, pipelineSummary, type StageDefaults } from "../../lib/dealMath";
import type { Deal } from "./types";

export default function PipelineForecast({ deals, cfg }: { deals: Deal[]; cfg: StageDefaults }) {
  const s = pipelineSummary(deals, cfg);
  const missing = s.openCount - s.withFeeCount;
  const tiles = [
    { label: "Open deals", value: String(s.openCount), note: null as string | null, tint: "var(--tint-1)" },
    {
      label: "Enterprise value in play",
      value: s.totalEnterpriseValue ? formatMoney(s.totalEnterpriseValue) : "$0",
      note: null,
      tint: "var(--tint-2)",
    },
    {
      label: "Expected fees",
      value: formatMoney(s.expectedFees) || "$0",
      note: missing > 0 ? `${missing} open ${missing === 1 ? "deal has" : "deals have"} no fee terms yet` : null,
      tint: "var(--tint-3)",
    },
    {
      label: "Weighted fee forecast",
      value: formatMoney(s.weightedFees) || "$0",
      note: s.stageDefaultCount > 0 ? `${s.stageDefaultCount} weighted by stage default` : null,
      tint: "var(--tint-4)",
    },
  ];
  const maxQ = Math.max(1, ...s.byQuarter.map((q) => q.weighted));

  return (
    <section aria-label="Pipeline value and fee forecast" className="mb-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="flex min-h-[112px] flex-col justify-between rounded-[var(--radius-lg)] p-4" style={{ background: t.tint }}>
            <span className="text-[13px] font-medium text-[var(--ink)]">{t.label}</span>
            <div>
              <div className="display text-[30px] font-bold leading-none tracking-tight tabular-nums text-[var(--ink)]">{t.value}</div>
              {t.note && <div className="mt-1 text-[11px] text-[var(--ink-soft)]">{t.note}</div>}
            </div>
          </div>
        ))}
      </div>
      {s.byQuarter.length > 0 && (
        <div className="card mt-3 p-4">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="text-[14px] font-bold text-[var(--ink)]">Weighted fees by expected close</h2>
            {s.noCloseDateWeighted > 0 && (
              <span className="text-[11px] text-[var(--ink-faint)]">{formatMoney(s.noCloseDateWeighted)} has no close date</span>
            )}
          </div>
          <ul className="space-y-1.5">
            {s.byQuarter.map((q) => (
              <li key={q.quarter} className="grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3 text-[13px]">
                <span className="font-semibold text-[var(--ink)]">{q.quarter}</span>
                <span className="h-2.5 rounded-full bg-[var(--paper-deep)]">
                  <span
                    className="block h-2.5 rounded-full bg-[var(--accent)]"
                    style={{ width: `${Math.max(4, Math.round((q.weighted / maxQ) * 100))}%` }}
                  />
                </span>
                <span className="numeric text-[var(--ink-soft)]">
                  {formatMoney(q.weighted)} of {formatMoney(q.expected)} · {q.count} {q.count === 1 ? "deal" : "deals"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
