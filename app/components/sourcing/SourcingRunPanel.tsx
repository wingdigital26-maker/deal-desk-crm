// Read-only summary of the weekly sourcing run (scrapers/pipeline.py): the last
// run's numbers and the desk-wide totals. Server component; no actions here.
import type { SourcingRun, SourcingTotals } from "../../lib/sourcing-runs";
import { humanDate } from "../../lib/dates";
import Panel from "../ui/Panel";

function Stat({ value, label, sub }: { value: number; label: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[22px] font-bold leading-tight text-[var(--ink)]">{value.toLocaleString("en-US")}</div>
      <div className="text-[13px] text-[var(--ink-soft)]">{label}</div>
      {sub && <div className="text-[12px] text-[var(--ink-faint)]">{sub}</div>}
    </div>
  );
}

function runtime(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 90) return `${seconds} sec`;
  const m = Math.round(seconds / 60);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} hr`;
}

export default function SourcingRunPanel({
  run,
  totals,
  goodFit,
}: {
  run: SourcingRun | null;
  totals: SourcingTotals;
  goodFit: number;
}) {
  if (!run) {
    return (
      <Panel title="Weekly sourcing run" className="mb-5">
        <p className="text-sm text-[var(--ink-soft)]">
          The sourcing run has not been run on this desk yet. When it runs it looks up each registry
          company&apos;s website, scores its fit, finds the owner and checks for new signals, and the
          results show here.
        </p>
      </Panel>
    );
  }
  const when = humanDate(run.finished_at ?? run.started_at);
  const took = runtime(run.runtime_seconds);
  const state = run.finished_at ? (run.interrupted ? "stopped early" : "finished") : "still running or stopped";
  return (
    <Panel title="Weekly sourcing run" className="mb-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[12px]">
        <span className="font-semibold text-[var(--ink-soft)]">Last run</span>
        <span className="text-[var(--ink-faint)]">
          {when ?? "date unknown"}, {state}
          {took ? `, ${took}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat value={run.checked} label="companies checked" />
        <Stat
          value={run.sites_found}
          label="websites confirmed"
          sub={run.sites_unconfirmed ? `${run.sites_unconfirmed} more not confirmed` : undefined}
        />
        <Stat value={run.fits} label={`good fits (${goodFit}+)`} />
        <Stat value={run.owners_found} label="owners named" />
        <Stat value={run.signals_new} label="new signals" sub={run.errors ? `${run.errors} errors` : undefined} />
      </div>
      <div className="mt-5 border-t border-[var(--rule)] pt-4">
        <div className="mb-2 text-[12px] font-semibold text-[var(--ink-soft)]">Whole desk</div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            value={totals.checked}
            label="companies checked"
            sub={`of ${totals.companies.toLocaleString("en-US")} so far`}
          />
          <Stat
            value={totals.withSite}
            label="with a confirmed website"
            sub={totals.unconfirmedSite ? `${totals.unconfirmedSite} possible, not confirmed` : undefined}
          />
          <Stat value={totals.goodFits} label={`good fits (${goodFit}+)`} />
          <Stat value={totals.ownersFound} label="with an owner named" />
        </div>
      </div>
    </Panel>
  );
}
