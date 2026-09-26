"use client";
// Pipeline value and fee forecast, as one compact strip. Every number is
// summed from real deal fields by app/lib/dealMath.ts; deals with no fee
// inputs are counted and named as missing, never estimated. The quarter
// breakdown sits behind a "By quarter" disclosure, collapsed by default.
import { useState } from "react";
import { formatMoney, pipelineSummary, type StageDefaults } from "../../lib/dealMath";
import type { Deal } from "./types";

export default function PipelineForecast({ deals, cfg }: { deals: Deal[]; cfg: StageDefaults }) {
  const [open, setOpen] = useState(false);
  const s = pipelineSummary(deals, cfg);
  const missing = s.openCount - s.withFeeCount;
  const stats = [
    { label: "Open deals", value: String(s.openCount), note: null as string | null },
    { label: "EV in play", value: s.totalEnterpriseValue ? formatMoney(s.totalEnterpriseValue) : "$0", note: null },
    {
      label: "Expected fees",
      value: formatMoney(s.expectedFees) || "$0",
      note: missing > 0 ? `${missing} ${missing === 1 ? "deal has" : "deals have"} no fee terms` : null,
    },
    {
      label: "Weighted forecast",
      value: formatMoney(s.weightedFees) || "$0",
      note: s.stageDefaultCount > 0 ? `${s.stageDefaultCount} weighted by stage default` : null,
    },
  ];
  const maxQ = Math.max(1, ...s.byQuarter.map((q) => q.weighted));

  return (
    <section aria-label="Pipeline value and fee forecast" className="card mb-4 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:flex-wrap sm:items-center">
          {stats.map((t, i) => (
            <div key={t.label} className={`min-w-0 ${i > 0 ? "sm:border-l sm:border-[var(--rule)] sm:pl-6" : ""}`}>
              <dt className="text-[12px] font-medium text-[var(--ink-soft)]">{t.label}</dt>
              <dd className="flex flex-wrap items-baseline gap-x-2">
                <span className="display text-[22px] font-bold leading-tight tracking-tight tabular-nums text-[var(--ink)]">{t.value}</span>
                {t.note && <span className="text-[11px] text-[var(--ink-faint)]">{t.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
        {s.byQuarter.length > 0 && (
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="forecast-quarters"
            className="inline-flex min-h-[44px] items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[13px] font-semibold text-[var(--accent-deep)] hover:bg-[var(--paper)]"
          >
            By quarter
            <span aria-hidden className="text-[11px]">{open ? "▲" : "▼"}</span>
          </button>
        )}
      </div>
      {open && s.byQuarter.length > 0 && (
        <div id="forecast-quarters" className="mt-2 border-t border-[var(--rule)] pt-2">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h2 className="text-[13px] font-bold text-[var(--ink)]">Weighted fees by expected close</h2>
            {s.noCloseDateWeighted > 0 && (
              <span className="text-[11px] text-[var(--ink-faint)]">{formatMoney(s.noCloseDateWeighted)} has no close date</span>
            )}
          </div>
          <ul className="space-y-1">
            {s.byQuarter.map((q) => (
              <li key={q.quarter} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 text-[12px]">
                <span className="font-semibold text-[var(--ink)]">{q.quarter}</span>
                <span className="h-2 rounded-full bg-[var(--paper-deep)]">
                  <span className="block h-2 rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(4, Math.round((q.weighted / maxQ) * 100))}%` }} />
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
