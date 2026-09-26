// P5 BANK / FIG: pure date math and labels for the regulatory approval tracker.
// No database import: safe to use from client components and from tests.
//
// Every number here is a TYPICAL timeline taken from published agency guidance
// and processing statistics. The UI labels them as guidance, never advice, and
// nothing computed here is ever saved without the banker clicking "Use".

export const REGULATORS = ["FDIC", "OCC", "FED", "STATE", "NCUA"] as const;
export type Regulator = (typeof REGULATORS)[number];

export const REGULATOR_LABELS: Record<Regulator, string> = {
  FDIC: "FDIC",
  OCC: "OCC",
  FED: "Federal Reserve",
  STATE: "State banking department",
  NCUA: "NCUA",
};

export const FILING_STATUSES = ["preparing", "filed", "accepted", "approved", "withdrawn", "denied"] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];
export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  preparing: "Preparing",
  filed: "Filed",
  accepted: "Accepted as complete",
  approved: "Approved",
  withdrawn: "Withdrawn",
  denied: "Denied",
};

export const VOTE_PARTIES = ["target", "acquirer"] as const;
export type VoteParty = (typeof VOTE_PARTIES)[number];
export const VOTE_PARTY_LABELS: Record<VoteParty, string> = { target: "Target shareholders", acquirer: "Acquirer shareholders" };

export const VOTE_RESULTS = ["pending", "approved", "rejected"] as const;
export type VoteResult = (typeof VOTE_RESULTS)[number];
export const VOTE_RESULT_LABELS: Record<VoteResult, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected" };

/** The six filing milestones, in the order they happen. */
export const FILING_DATE_FIELDS = [
  "filed_at",
  "accepted_complete_at",
  "public_notice_at",
  "comment_end_at",
  "approval_at",
  "consummation_eligible_at",
] as const;
export type FilingDateField = (typeof FILING_DATE_FIELDS)[number];
export const FILING_DATE_LABELS: Record<FilingDateField, string> = {
  filed_at: "Filed",
  accepted_complete_at: "Accepted as complete",
  public_notice_at: "Public notice",
  comment_end_at: "Comment period ends",
  approval_at: "Approval",
  consummation_eligible_at: "Consummation eligible",
};

export const VOTE_DATE_FIELDS = ["record_date", "notice_mailed_at", "meeting_at"] as const;
export type VoteDateField = (typeof VOTE_DATE_FIELDS)[number];
export const VOTE_DATE_LABELS: Record<VoteDateField, string> = {
  record_date: "Record date",
  notice_mailed_at: "Proxy or notice mailed",
  meeting_at: "Meeting",
};

/** Typical timelines (guidance only). */
export const GUIDANCE = {
  commentDays: 30, // FDIC / OCC public notice and comment period
  dojReportDays: 30, // DOJ competitive-factors report
  approvalDays: { FDIC: { expedited: 45, standard: 60 }, OCC: { expedited: 45, standard: 60 } },
  fedApprovalDays: { median: 71, average: 102 }, // Fed M&A processing, H2 2024
  waitingDays: 30, // post-approval waiting period before consummation
  waitingDaysWithDoj: 15, // shortened with DOJ concurrence
  ncuaMemberNoticeDays: { min: 45, max: 90 },
} as const;

export type Filing = {
  id: number;
  deal_id: number;
  regulator: Regulator;
  agency_label: string | null;
  filed_at: string | null;
  accepted_complete_at: string | null;
  public_notice_at: string | null;
  comment_end_at: string | null;
  approval_at: string | null;
  doj_concurrence: number;
  consummation_eligible_at: string | null;
  status: FilingStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ShareholderVote = {
  id: number;
  deal_id: number;
  party: VoteParty;
  record_date: string | null;
  notice_mailed_at: string | null;
  meeting_at: string | null;
  result: VoteResult | null;
  votes_for_pct: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// ---- date helpers (UTC on the calendar date, so no DST or timezone drift) ----

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD plus n calendar days, or null when the input is empty or not a real date. */
export function addDays(iso: string | null | undefined, n: number): string | null {
  if (!iso || !ISO_RE.test(iso)) return null;
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

/** "Nov 12" (adds the year when it is not the reference year). */
export function shortDate(iso: string, refYear?: number): string {
  const d = new Date(iso + "T00:00:00Z");
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  if (refYear !== undefined && d.getUTCFullYear() !== refYear) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}

export function filingLabel(f: Pick<Filing, "regulator" | "agency_label">): string {
  return f.agency_label?.trim() || REGULATOR_LABELS[f.regulator];
}

// ---- suggestions ----

export type ApprovalWindow = { earliest: string; latest: string; basis: string };

export type Suggestions = {
  /** public notice + 30 days. */
  comment_end_at: string | null;
  /** approval + 30 days, or + 15 with DOJ concurrence. */
  consummation_eligible_at: string | null;
  /** Expected approval window counted from acceptance as complete; null when there is no default. */
  expected_approval: ApprovalWindow | null;
  /** Plain-English reason when there is no expected approval window. */
  expected_approval_note: string | null;
};

type SuggestInput = Pick<Filing, "regulator" | "accepted_complete_at" | "public_notice_at" | "approval_at"> & {
  doj_concurrence?: number | boolean | null;
};

/** Suggested dates for one filing. Never saved automatically. */
export function suggestions(f: SuggestInput): Suggestions {
  const waiting = f.doj_concurrence ? GUIDANCE.waitingDaysWithDoj : GUIDANCE.waitingDays;
  let expected: ApprovalWindow | null = null;
  let note: string | null = null;
  const acc = f.accepted_complete_at;
  if (f.regulator === "FDIC" || f.regulator === "OCC") {
    const g = GUIDANCE.approvalDays[f.regulator];
    const earliest = addDays(acc, g.expedited);
    const latest = addDays(acc, g.standard);
    if (earliest && latest) expected = { earliest, latest, basis: `${g.expedited} days expedited to ${g.standard} days standard from acceptance` };
    else note = "Add the date the application was accepted as complete to see the typical approval window.";
  } else if (f.regulator === "FED") {
    const earliest = addDays(acc, GUIDANCE.fedApprovalDays.median);
    const latest = addDays(acc, GUIDANCE.fedApprovalDays.average);
    if (earliest && latest)
      expected = {
        earliest,
        latest,
        basis: `${GUIDANCE.fedApprovalDays.median} day median to ${GUIDANCE.fedApprovalDays.average} day average from acceptance (Fed M&A, H2 2024)`,
      };
    else note = "Add the date the application was accepted as complete to see the typical approval window.";
  } else {
    note =
      f.regulator === "STATE"
        ? "No typical approval window: state banking departments set their own timelines."
        : "No typical approval window: NCUA timing depends on the transaction and the member vote.";
  }
  return {
    comment_end_at: addDays(f.public_notice_at, GUIDANCE.commentDays),
    consummation_eligible_at: addDays(f.approval_at, waiting),
    expected_approval: expected,
    expected_approval_note: note,
  };
}

// ---- ordering checks (only where the order is certain) ----

const ORDER_RULES: [later: FilingDateField, earlier: FilingDateField, message: string][] = [
  ["accepted_complete_at", "filed_at", "Accepted as complete cannot be before the filing date"],
  ["comment_end_at", "public_notice_at", "Comment period end cannot be before the public notice date"],
  ["consummation_eligible_at", "approval_at", "Consummation eligible cannot be before the approval date"],
];

/** First ordering problem in a (merged) filing, naming the later field, or null. */
export function orderingError(f: Partial<Record<FilingDateField, string | null>>): { field: FilingDateField; message: string } | null {
  for (const [later, earlier, message] of ORDER_RULES) {
    const a = f[later];
    const b = f[earlier];
    if (a && b && a < b) return { field: later, message };
  }
  return null;
}

// ---- upcoming dates (Today) ----

export type RegulatoryDate = { date: string; label: string; kind: "filing" | "vote"; id: number };

const INACTIVE: FilingStatus[] = ["withdrawn", "denied"];

/** Every saved regulatory or vote date from `today` through `today + withinDays`, soonest first. */
export function upcomingRegulatoryDates(
  filings: Filing[],
  votes: ShareholderVote[],
  today: string,
  withinDays = 30
): RegulatoryDate[] {
  const end = addDays(today, withinDays) ?? today;
  const out: RegulatoryDate[] = [];
  const inWindow = (d: string | null): d is string => !!d && d >= today && d <= end;
  for (const f of filings) {
    if (INACTIVE.includes(f.status)) continue;
    for (const field of FILING_DATE_FIELDS) {
      const d = f[field];
      if (inWindow(d)) out.push({ date: d, label: `${filingLabel(f)}: ${FILING_DATE_LABELS[field].toLowerCase()}`, kind: "filing", id: f.id });
    }
  }
  for (const v of votes) {
    for (const field of VOTE_DATE_FIELDS) {
      const d = v[field];
      if (field === "meeting_at" && v.result && v.result !== "pending") continue;
      if (inWindow(d)) out.push({ date: d, label: `${VOTE_PARTY_LABELS[v.party]}: ${VOTE_DATE_LABELS[field].toLowerCase()}`, kind: "vote", id: v.id });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

/** The next saved regulatory or vote date on or after today (no window limit), or null. */
export function nextRegulatoryDate(filings: Filing[], votes: ShareholderVote[], today: string): RegulatoryDate | null {
  return upcomingRegulatoryDates(filings, votes, today, 365 * 100)[0] ?? null;
}
