// "What matters" rules for a deal, shared by the pipeline list, the deal page
// and Today. Pure and client-safe: no database, no clock unless the caller
// leaves `today` out. One deal gets at most ONE short label, picked by
// priority: overdue next step, then due today, then quiet.
//
// Dates: next_step_due is a plain local "YYYY-MM-DD". Interaction stamps are
// SQLite UTC "YYYY-MM-DD HH:MM:SS"; only their calendar date is used.

export const QUIET_DAYS = 21;

/** Stages where a slip costs the most (a signed LOI heading to close). */
export const LATE_STAGES = ["LOI"] as const;

export type AttentionDeal = {
  stage: string;
  next_step_due?: string | null;
  last_interaction_at?: string | null;
  last_activity_at?: string | null;
  created_at?: string | null;
};

export type AttentionKind = "overdue" | "due-today" | "quiet";

export type Attention = {
  /** True for Closed / Passed: shown dimmed, sorted last, never flagged. */
  closed: boolean;
  /** Open deal in a late stage (LOI): emphasise the stage. */
  late: boolean;
  /** Days past the next-step due date, or null when not overdue. */
  overdueDays: number | null;
  dueToday: boolean;
  /** Whole days since the last interaction (falls back to any activity, then creation). */
  quietDays: number | null;
  quiet: boolean;
  /** The single label to show, or null when nothing needs attention. */
  label: { kind: AttentionKind; text: string; tone: "stop" | "warn" | "info" } | null;
};

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

const validDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}/.test(s);

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function attention(
  deal: AttentionDeal,
  closedStages: readonly string[],
  today: string = localToday()
): Attention {
  const closed = closedStages.includes(deal.stage);
  const late = !closed && (LATE_STAGES as readonly string[]).includes(deal.stage);
  const t = dayNumber(today);

  let overdueDays: number | null = null;
  let dueToday = false;
  if (!closed && validDate(deal.next_step_due)) {
    const diff = t - dayNumber(deal.next_step_due);
    if (diff > 0) overdueDays = diff;
    else if (diff === 0) dueToday = true;
  }

  const since = [deal.last_interaction_at, deal.last_activity_at, deal.created_at].find(validDate);
  const quietDays = since ? Math.max(0, t - dayNumber(since)) : null;
  const quiet = !closed && quietDays != null && quietDays >= QUIET_DAYS;

  let label: Attention["label"] = null;
  if (overdueDays != null) label = { kind: "overdue", text: `Overdue ${plural(overdueDays, "day")}`, tone: "stop" };
  else if (dueToday) label = { kind: "due-today", text: "Due today", tone: "info" };
  else if (quiet) label = { kind: "quiet", text: `Quiet ${plural(quietDays!, "day")}`, tone: "warn" };

  return { closed, late, overdueDays, dueToday, quietDays, quiet, label };
}

export type AttentionSummary = { overdue: number; quiet: number; dueToday: number };

/** Counts for the "Needs attention" line. A deal counts under its ONE label only. */
export function attentionSummary(items: Attention[]): AttentionSummary {
  const out: AttentionSummary = { overdue: 0, quiet: 0, dueToday: 0 };
  for (const a of items) {
    if (a.label?.kind === "overdue") out.overdue += 1;
    else if (a.label?.kind === "quiet") out.quiet += 1;
    else if (a.label?.kind === "due-today") out.dueToday += 1;
  }
  return out;
}

/** "3 overdue, 2 quiet, 1 due today", or null when nothing needs attention. */
export function summaryText(s: AttentionSummary): string | null {
  const parts = [
    s.overdue ? `${s.overdue} overdue` : null,
    s.quiet ? `${s.quiet} quiet` : null,
    s.dueToday ? `${s.dueToday} due today` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}
