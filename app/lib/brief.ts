// Morning brief: one printable page of what needs the banker today. Deal Desk
// never emails it; the banker prints it or reads it on screen.
//
// Split in two so the rules are unit-tested without a database:
//   buildBrief(input, today)  pure: turns raw rows into sections of one-line items
//   loadBrief(today)          reads the rows (server only) and calls buildBrief
//
// Reuses the house rules rather than restating them: attention.ts for overdue,
// due today and quiet; followups.ts for buyer follow-ups; regulatory.ts for
// upcoming regulatory dates; cadence.ts for people due a touch.
import { db } from "./db";
import { firm } from "../../firm.config";
import { attention } from "./attention";
import { FOLLOW_UP_DONE_STAGES, followUpTitle, isFollowUpDue } from "./followups";
import { BUYER_STAGE_LABELS, isBuyerStage, stageRank, type BuyerStage } from "./buyerStages";
import { upcomingRegulatoryDates, type Filing, type ShareholderVote } from "./regulatory";
import { relationshipsDue, type DueRelationship } from "./cadence";
import { canSeeDeal } from "./dealAccess";

type DealViewer = Parameters<typeof canSeeDeal>[0];
import { formatMoney } from "./dealMath";

/** A buyer at NDA signed or later with no stage move this long is waiting on the banker. */
export const STALE_BUYER_DAYS = 14;
export const BID_WINDOW_DAYS = 7;
export const REGULATORY_WINDOW_DAYS = 14;

export type BriefTask = { id: number; title: string; due: string; deal_id: number | null; deal_title: string | null; company_name: string | null };
export type BriefDeal = {
  id: number;
  title: string;
  company_name: string;
  stage: string;
  next_step: string | null;
  next_step_due: string | null;
  last_interaction_at: string | null;
  last_activity_at: string | null;
  created_at: string | null;
};
export type BriefBuyer = {
  id: number;
  deal_id: number;
  deal_title: string;
  company_name: string;
  buyer_name: string;
  stage: string;
  next_step: string | null;
  next_step_due: string | null;
  /** Latest stage move (SQLite UTC stamp), or null when never moved. */
  last_move_at: string | null;
};
export type BriefBid = {
  deal_buyer_id: number;
  deal_id: number;
  deal_title: string;
  company_name: string;
  buyer_name: string;
  /** ioi_low | ioi_high | loi_value */
  field: string;
  created_at: string;
  ioi_low: number | null;
  ioi_high: number | null;
  loi_value: number | null;
};
export type BriefFigDeal = { id: number; company_name: string; filings: Filing[]; votes: ShareholderVote[] };

export type BriefInput = {
  tasks: BriefTask[];
  deals: BriefDeal[];
  buyers: BriefBuyer[];
  bids: BriefBid[];
  figDeals: BriefFigDeal[];
  people: DueRelationship[];
  closedStages: readonly string[];
};

export type BriefItem = {
  key: string;
  /** The main words, e.g. "Buyer: Red Oak Capital on Project Falcon". */
  text: string;
  /** Short supporting words on the same line. */
  detail: string | null;
  /** Right-hand fact: "3 days late", "Today", "Oct 2". */
  meta: string | null;
  tone: "stop" | "warn" | "info" | null;
  href: string;
};

export type BriefSectionId = "overdue" | "today" | "waiting" | "quiet" | "bids" | "regulatory" | "people";
export type BriefSection = { id: BriefSectionId; title: string; items: BriefItem[] };
export type Brief = { today: string; sections: BriefSection[]; counts: Record<BriefSectionId, number> };

const TITLES: Record<BriefSectionId, string> = {
  overdue: "Overdue",
  today: "Due today",
  waiting: "Buyers waiting on you",
  quiet: "Deals going quiet",
  bids: `Bids received in the last ${BID_WINDOW_DAYS} days`,
  regulatory: `Regulatory dates in the next ${REGULATORY_WINDOW_DAYS} days`,
  people: "People due for a touch",
};

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};
const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shortDay = (iso: string) =>
  new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const onDeal = (title: string | null | undefined, company: string | null | undefined) => title?.trim() || company?.trim() || "";
const stageLabel = (s: string) => (isBuyerStage(s) ? BUYER_STAGE_LABELS[s] : s);

type Due = { date: string; item: Omit<BriefItem, "meta" | "tone"> };

function dueItems(input: BriefInput, today: string): Due[] {
  const out: Due[] = [];
  for (const t of input.tasks) {
    if (!t.due) continue;
    out.push({
      date: t.due.slice(0, 10),
      item: {
        key: `task-${t.id}`,
        text: t.title,
        detail: ["Task", t.company_name].filter(Boolean).join(" · "),
        href: t.deal_id ? `/pipeline/${t.deal_id}` : "/tasks",
      },
    });
  }
  for (const d of input.deals) {
    if (!d.next_step_due || input.closedStages.includes(d.stage)) continue;
    out.push({
      date: d.next_step_due.slice(0, 10),
      item: { key: `deal-${d.id}`, text: d.next_step?.trim() || "Next step", detail: `Deal step · ${d.company_name}`, href: `/pipeline/${d.id}` },
    });
  }
  for (const b of input.buyers) {
    if (!b.next_step_due || !isFollowUpDue(b, today)) continue;
    out.push({
      date: b.next_step_due.slice(0, 10),
      item: {
        key: `buyer-${b.id}`,
        text: followUpTitle(b.buyer_name, b.deal_title, b.company_name),
        detail: b.next_step?.trim() || "Follow up",
        href: `/pipeline/${b.deal_id}#buyers`,
      },
    });
  }
  return out.filter((x) => x.date <= today).sort((a, b) => a.date.localeCompare(b.date) || a.item.text.localeCompare(b.item.text));
}

export function buildBrief(input: BriefInput, today: string): Brief {
  const due = dueItems(input, today);
  const overdue: BriefItem[] = due
    .filter((x) => x.date < today)
    .map((x) => {
      const late = daysBetween(x.date, today);
      return { ...x.item, meta: `Overdue ${plural(late, "day")}`, tone: "stop" };
    });
  const dueToday: BriefItem[] = due.filter((x) => x.date === today).map((x) => ({ ...x.item, meta: "Today", tone: "info" }));

  // Buyers waiting on you: a follow-up due, or no stage move in 14+ days at NDA signed or later.
  const ndaSigned = stageRank("nda_signed");
  const waiting: { item: BriefItem; sort: number }[] = [];
  for (const b of input.buyers) {
    if ((FOLLOW_UP_DONE_STAGES as readonly string[]).includes(b.stage) || !isBuyerStage(b.stage)) continue;
    const followUp = isFollowUpDue(b, today);
    const idle = b.last_move_at ? daysBetween(b.last_move_at, today) : null;
    const stale = stageRank(b.stage as BuyerStage) >= ndaSigned && idle != null && idle >= STALE_BUYER_DAYS;
    if (!followUp && !stale) continue;
    const overdueBy = followUp ? daysBetween(b.next_step_due!, today) : 0;
    const reasons = [
      stageLabel(b.stage),
      followUp ? (overdueBy > 0 ? `follow-up overdue since ${shortDay(b.next_step_due!)}` : "follow-up due today") : null,
      followUp && b.next_step?.trim() ? b.next_step.trim() : null,
      stale ? `no move in ${idle} days` : null,
    ].filter(Boolean);
    waiting.push({
      item: {
        key: `waiting-${b.id}`,
        text: `${b.buyer_name} on ${onDeal(b.deal_title, b.company_name)}`,
        detail: reasons.join(" · "),
        meta: followUp ? (overdueBy > 0 ? `Overdue ${plural(overdueBy, "day")}` : "Due today") : `Idle ${plural(idle ?? 0, "day")}`,
        tone: followUp ? (overdueBy > 0 ? "stop" : "info") : "warn",
        href: `/pipeline/${b.deal_id}#buyers`,
      },
      // Follow-ups first (oldest due date first), then the longest-idle buyers.
      sort: followUp ? -1_000_000 + dayNumber(b.next_step_due!) : -(idle ?? 0),
    });
  }
  waiting.sort((a, b) => a.sort - b.sort || a.item.text.localeCompare(b.item.text));

  const quiet: BriefItem[] = input.deals
    .map((d) => ({ d, a: attention(d, input.closedStages, today) }))
    .filter((x) => x.a.quiet)
    .sort((x, y) => (y.a.quietDays ?? 0) - (x.a.quietDays ?? 0))
    .map(({ d, a }) => ({
      key: `quiet-${d.id}`,
      text: d.company_name,
      detail: [d.stage, d.title].filter(Boolean).join(" · "),
      meta: `Quiet ${plural(a.quietDays ?? 0, "day")}`,
      tone: "warn" as const,
      href: `/pipeline/${d.id}`,
    }));

  // Bids: the latest IOI or LOI change per buyer inside the window, one line each.
  const latest = new Map<string, BriefBid>();
  for (const r of input.bids) {
    const age = daysBetween(r.created_at, today);
    if (age < 0 || age > BID_WINDOW_DAYS) continue;
    const kind = r.field === "loi_value" ? "loi" : "ioi";
    const k = `${r.deal_buyer_id}-${kind}`;
    const cur = latest.get(k);
    if (!cur || cur.created_at < r.created_at) latest.set(k, r);
  }
  const bids: BriefItem[] = [...latest.entries()]
    .map(([k, r]) => {
      const isLoi = k.endsWith("-loi");
      const value = isLoi
        ? r.loi_value != null
          ? `LOI ${formatMoney(r.loi_value)}`
          : null
        : r.ioi_low != null || r.ioi_high != null
          ? `IOI ${r.ioi_low != null && r.ioi_high != null && r.ioi_low !== r.ioi_high ? `${formatMoney(r.ioi_low)} to ${formatMoney(r.ioi_high)}` : formatMoney(r.ioi_low ?? r.ioi_high)}`
          : null;
      return { r, value };
    })
    .filter((x) => x.value)
    .sort((a, b) => b.r.created_at.localeCompare(a.r.created_at))
    .map(({ r, value }) => ({
      key: `bid-${r.deal_buyer_id}-${r.field === "loi_value" ? "loi" : "ioi"}`,
      text: `${r.buyer_name} on ${onDeal(r.deal_title, r.company_name)}`,
      detail: value,
      meta: shortDay(r.created_at),
      tone: null,
      href: `/pipeline/${r.deal_id}#buyers`,
    }));

  const regulatory: BriefItem[] = input.figDeals
    .flatMap((d) => upcomingRegulatoryDates(d.filings, d.votes, today, REGULATORY_WINDOW_DAYS).map((r) => ({ d, r })))
    .sort((a, b) => a.r.date.localeCompare(b.r.date) || a.d.company_name.localeCompare(b.d.company_name))
    .map(({ d, r }) => ({
      key: `reg-${d.id}-${r.kind}-${r.id}-${r.label}`,
      text: d.company_name,
      detail: r.label,
      meta: r.date === today ? "Today" : shortDay(r.date),
      tone: r.date === today ? ("info" as const) : null,
      href: `/pipeline/${d.id}`,
    }));

  const people: BriefItem[] = input.people.map((p) => ({
    key: `person-${p.id}`,
    text: [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed",
    detail: p.company_name,
    meta: p.days_since == null ? "Never touched" : `${plural(p.days_since, "day")} since a touch`,
    tone: null,
    href: `/contacts/${p.id}`,
  }));

  const all: BriefSection[] = [
    { id: "overdue", title: TITLES.overdue, items: overdue },
    { id: "today", title: TITLES.today, items: dueToday },
    { id: "waiting", title: TITLES.waiting, items: waiting.map((w) => w.item) },
    { id: "quiet", title: TITLES.quiet, items: quiet },
    { id: "bids", title: TITLES.bids, items: bids },
    { id: "regulatory", title: TITLES.regulatory, items: regulatory },
    { id: "people", title: TITLES.people, items: people },
  ];
  const counts = Object.fromEntries(all.map((s) => [s.id, s.items.length])) as Record<BriefSectionId, number>;
  return { today, sections: all.filter((s) => s.items.length > 0), counts };
}

/** "3 overdue, 2 due today, 4 buyers waiting", or null when the desk is clear. */
export function briefCountsText(c: Record<BriefSectionId, number>): string | null {
  const parts = [
    c.overdue ? `${c.overdue} overdue` : null,
    c.today ? `${c.today} due today` : null,
    c.waiting ? `${plural(c.waiting, "buyer")} waiting` : null,
    c.quiet ? `${plural(c.quiet, "deal")} going quiet` : null,
    c.bids ? `${plural(c.bids, "bid")} received` : null,
    c.regulatory ? `${plural(c.regulatory, "regulatory date")}` : null,
    c.people ? `${c.people} ${c.people === 1 ? "person" : "people"} due a touch` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

// ---- server read ----

export function loadBrief(today: string, user?: DealViewer): Brief {
  const d = db();
  // MNPI walls: drop anything on a deal this user is not cleared for.
  const can = (dealId: number | null | undefined) => dealId == null || !user || canSeeDeal(user, dealId);
  const closed = firm.closedStages;
  const ph = closed.map(() => "?").join(",") || "''";
  const tasks = d
    .prepare(
      `SELECT t.id, t.title, t.due, t.deal_id, dl.title AS deal_title, c.name AS company_name
       FROM tasks t LEFT JOIN deals dl ON dl.id = t.deal_id LEFT JOIN companies c ON c.id = dl.company_id
       WHERE t.done = 0 AND t.due IS NOT NULL AND t.due <= ?`
    )
    .all(today) as BriefTask[];
  const deals = d
    .prepare(
      `SELECT dl.id, dl.title, c.name AS company_name, dl.stage, dl.next_step, dl.next_step_due, dl.created_at,
              (SELECT MAX(a.created_at) FROM activities a WHERE a.deal_id = dl.id AND a.kind IN ('note','call','meeting','email-in','email-out')) AS last_interaction_at,
              (SELECT MAX(a.created_at) FROM activities a WHERE a.deal_id = dl.id) AS last_activity_at
       FROM deals dl JOIN companies c ON c.id = dl.company_id
       WHERE dl.stage NOT IN (${ph})`
    )
    .all(...closed) as BriefDeal[];
  const buyers = d
    .prepare(
      `SELECT b.id, b.deal_id, dl.title AS deal_title, s.name AS company_name, c.name AS buyer_name, b.stage, b.next_step, b.next_step_due,
              COALESCE((SELECT MAX(h.created_at) FROM deal_buyer_stage_history h WHERE h.deal_buyer_id = b.id), b.created_at) AS last_move_at
       FROM deal_buyers b
       JOIN deals dl ON dl.id = b.deal_id
       JOIN companies s ON s.id = dl.company_id
       JOIN companies c ON c.id = b.buyer_company_id
       WHERE b.removed_at IS NULL AND b.stage NOT IN ('closed', 'declined') AND dl.stage NOT IN (${ph})
       ORDER BY c.name COLLATE NOCASE`
    )
    .all(...closed) as BriefBuyer[];
  const bids = d
    .prepare(
      `SELECT r.deal_buyer_id, b.deal_id, dl.title AS deal_title, s.name AS company_name, c.name AS buyer_name, r.field, r.created_at,
              b.ioi_low, b.ioi_high, b.loi_value
       FROM deal_buyer_revisions r
       JOIN deal_buyers b ON b.id = r.deal_buyer_id
       JOIN deals dl ON dl.id = b.deal_id
       JOIN companies s ON s.id = dl.company_id
       JOIN companies c ON c.id = b.buyer_company_id
       WHERE r.field IN ('ioi_low', 'ioi_high', 'loi_value') AND r.new_value IS NOT NULL
         AND b.removed_at IS NULL AND r.created_at >= datetime('now', ?)`
    )
    .all(`-${BID_WINDOW_DAYS + 1} days`) as BriefBid[];
  const figDeals = (
    d.prepare(`SELECT dl.id, c.name AS company_name FROM deals dl JOIN companies c ON c.id = dl.company_id WHERE dl.fig_track = 1`).all() as {
      id: number;
      company_name: string;
    }[]
  ).map((x) => ({
    ...x,
    filings: d.prepare("SELECT * FROM deal_regulatory_filings WHERE deal_id = ?").all(x.id) as Filing[],
    votes: d.prepare("SELECT * FROM deal_shareholder_votes WHERE deal_id = ?").all(x.id) as ShareholderVote[],
  }));
  const people = relationshipsDue(50);
  return buildBrief(
    {
      tasks: tasks.filter((t) => can(t.deal_id)),
      deals: deals.filter((x) => can(x.id)),
      buyers: buyers.filter((b) => can(b.deal_id)),
      bids: bids.filter((b) => can(b.deal_id)),
      figDeals: figDeals.filter((f) => can(f.id)),
      people,
      closedStages: closed,
    },
    today
  );
}
