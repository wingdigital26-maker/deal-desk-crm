// Timeline strip for the regulatory tracker: one row per filing and per
// shareholder vote, plain CSS bars positioned by date, today marked. Saved
// dates only; the expected approval window is drawn as an outline so it never
// reads as a real date.
import {
  FILING_DATE_FIELDS,
  FILING_DATE_LABELS,
  VOTE_DATE_FIELDS,
  VOTE_DATE_LABELS,
  VOTE_PARTY_LABELS,
  daysBetween,
  filingLabel,
  shortDate,
  suggestions,
  type Filing,
  type ShareholderVote,
} from "../../lib/regulatory";

type Tick = { date: string; label: string };
type Bar = { from: string; to: string; tone: "review" | "agency" | "comment" | "waiting" | "vote" | "expected"; label: string };
type Row = { key: string; label: string; ticks: Tick[]; bars: Bar[] };

const TONE: Record<Bar["tone"], string> = {
  review: "top-1 bottom-1 bg-[var(--tint-2)]",
  agency: "top-1 bottom-1 bg-[var(--tint-4)]",
  comment: "bottom-1 h-2 bg-[var(--royal)]",
  waiting: "top-1 bottom-1 bg-[var(--navy)]",
  vote: "top-1 bottom-1 bg-[var(--tint-3)]",
  expected: "top-1 bottom-1 border border-dashed border-[var(--ink-faint)] bg-transparent",
};

const SWATCH: Record<Bar["tone"], string> = {
  review: "bg-[var(--tint-2)]",
  agency: "bg-[var(--tint-4)]",
  comment: "bg-[var(--royal)]",
  waiting: "bg-[var(--navy)]",
  vote: "bg-[var(--tint-3)]",
  expected: "border border-dashed border-[var(--ink-faint)]",
};

const LEGEND: [Bar["tone"], string][] = [
  ["review", "Filed to accepted"],
  ["agency", "Agency review"],
  ["comment", "Comment period"],
  ["expected", "Typical approval window"],
  ["waiting", "Post-approval wait"],
  ["vote", "Shareholder vote"],
];

function filingRow(f: Filing, today: string): Row {
  const ticks: Tick[] = FILING_DATE_FIELDS.filter((k) => f[k]).map((k) => ({ date: f[k]!, label: FILING_DATE_LABELS[k] }));
  const bars: Bar[] = [];
  if (f.filed_at && f.accepted_complete_at) bars.push({ from: f.filed_at, to: f.accepted_complete_at, tone: "review", label: "Filed to accepted" });
  const s = suggestions(f);
  if (f.accepted_complete_at) {
    const end = f.approval_at ?? (today > f.accepted_complete_at ? today : null);
    if (end) bars.push({ from: f.accepted_complete_at, to: end, tone: "agency", label: "Agency review" });
    if (!f.approval_at && s.expected_approval)
      bars.push({ from: s.expected_approval.earliest, to: s.expected_approval.latest, tone: "expected", label: "Typical approval window" });
  }
  if (f.public_notice_at && f.comment_end_at) bars.push({ from: f.public_notice_at, to: f.comment_end_at, tone: "comment", label: "Comment period" });
  if (f.approval_at && f.consummation_eligible_at)
    bars.push({ from: f.approval_at, to: f.consummation_eligible_at, tone: "waiting", label: "Post-approval wait" });
  return { key: `f${f.id}`, label: filingLabel(f), ticks, bars };
}

function voteRow(v: ShareholderVote): Row {
  const ticks: Tick[] = VOTE_DATE_FIELDS.filter((k) => v[k]).map((k) => ({ date: v[k]!, label: VOTE_DATE_LABELS[k] }));
  const bars: Bar[] = [];
  const first = ticks[0]?.date;
  const last = ticks.at(-1)?.date;
  if (first && last && first !== last) bars.push({ from: first, to: last, tone: "vote", label: "Shareholder vote" });
  return { key: `v${v.id}`, label: VOTE_PARTY_LABELS[v.party], ticks, bars };
}

function monthTicks(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start.slice(0, 7) + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  const span = daysBetween(start, end);
  const step = span > 540 ? 3 : span > 270 ? 2 : 1;
  while (d.toISOString().slice(0, 10) <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCMonth(d.getUTCMonth() + step);
  }
  return out;
}

export default function RegulatoryTimeline({ filings, votes, today }: { filings: Filing[]; votes: ShareholderVote[]; today: string }) {
  const rows = [...filings.map((f) => filingRow(f, today)), ...votes.map(voteRow)].filter((r) => r.ticks.length > 0);
  if (rows.length === 0) {
    return (
      <p className="rounded-[var(--radius-sm)] bg-[var(--paper)] px-4 py-3 text-sm text-[var(--ink-soft)]">
        The timeline fills in as you add dates to the filings and votes below.
      </p>
    );
  }
  const all = [today, ...rows.flatMap((r) => [...r.ticks.map((t) => t.date), ...r.bars.flatMap((b) => [b.from, b.to])])].sort();
  const pad = Math.max(3, Math.round(daysBetween(all[0], all.at(-1)!) * 0.04));
  const startMs = Date.parse(all[0] + "T00:00:00Z") - pad * 86400000;
  const endMs = Date.parse(all.at(-1)! + "T00:00:00Z") + pad * 86400000;
  const start = new Date(startMs).toISOString().slice(0, 10);
  const end = new Date(endMs).toISOString().slice(0, 10);
  const pct = (d: string) => ((Date.parse(d + "T00:00:00Z") - startMs) / (endMs - startMs)) * 100;
  const year = Number(today.slice(0, 4));
  const todayPct = pct(today);

  return (
    <div>
      <div className="flex gap-3">
        <div className="hidden w-52 shrink-0 sm:block" />
        <div className="relative h-6 flex-1 text-[11px] text-[var(--ink-faint)]">
          {monthTicks(start, end).map((m) => (
            <span key={m} className="absolute top-0 -translate-x-1/2 whitespace-nowrap" style={{ left: `${pct(m)}%` }}>
              {new Date(m + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC", ...(m.slice(0, 4) !== String(year) ? { year: "2-digit" } : {}) })}
            </span>
          ))}
        </div>
      </div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <span className="shrink-0 text-[13px] font-semibold leading-tight sm:w-52 text-[var(--ink)]" title={r.label}>
              {r.label}
            </span>
            <div className="relative h-8 flex-1 rounded-[8px] bg-[var(--paper)]">
              {r.bars.map((b, i) => (
                <span
                  key={i}
                  title={`${b.label}: ${shortDate(b.from, year)} to ${shortDate(b.to, year)}`}
                  className={`absolute rounded-[5px] ${TONE[b.tone]}`}
                  style={{ left: `${pct(b.from)}%`, width: `${Math.max(0.6, pct(b.to) - pct(b.from))}%` }}
                />
              ))}
              {r.ticks.map((t) => (
                <span
                  key={t.label}
                  title={`${t.label}: ${shortDate(t.date, year)}`}
                  className="absolute top-0 bottom-0 w-[2px] -translate-x-1/2 bg-[var(--ink)]"
                  style={{ left: `${pct(t.date)}%` }}
                >
                  <span className="sr-only">{`${t.label}: ${shortDate(t.date, year)}`}</span>
                </span>
              ))}
              <span
                aria-hidden
                className="absolute -top-1 -bottom-1 w-0 -translate-x-1/2 border-l-2 border-dashed border-[var(--accent)]"
                style={{ left: `${todayPct}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex gap-3">
        <div className="hidden w-52 shrink-0 sm:block" />
        <div className="relative h-5 flex-1">
          <span
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-ink)]"
            style={{ left: `${Math.min(94, Math.max(6, todayPct))}%` }}
          >
            Today {shortDate(today)}
          </span>
        </div>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--ink-soft)]">
        {LEGEND.map(([tone, label]) => (
          <li key={tone} className="flex items-center gap-1.5">
            <span aria-hidden className={`inline-block h-3 w-5 rounded-[3px] ${SWATCH[tone]}`} />
            {label}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-[2px] bg-[var(--ink)]" />
          Milestone date (hover for detail)
        </li>
      </ul>
    </div>
  );
}
