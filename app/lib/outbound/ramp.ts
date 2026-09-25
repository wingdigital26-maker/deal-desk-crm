// Pure math for the mailbox warmup ramp. No db access here so this is
// trivially unit-testable. Honest by construction: capacity comes from
// the configured ramp table and the count of mailboxes, never invented.
import type { firm as Firm } from "../../../firm.config";

export type OutboundConfig = Pick<
  typeof Firm.outbound,
  "warmupRampPerMailbox" | "maxPerMailboxPerDay" | "sendDays" | "weeklyTarget"
>;

export type MailboxRamp = {
  warmupStarted: string | null; // ISO date string, or null if warmup has not begun
  paused?: boolean;
  dailyCap?: number | null; // provider-side daily limit (e.g. Instantly's), tightens only
};

const DAY_MS = 24 * 60 * 60 * 1000;

// A stored "YYYY-MM-DD" is a calendar date, not an instant. new Date("2026-01-07")
// parses as UTC midnight, which is the PREVIOUS evening anywhere west of UTC and
// would advance every warmup ramp a day early. Build the local date from its parts.
function parseLocalDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(value);
}

function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeek(d: Date): Date {
  // Monday as the start of the week, matching firm.config sendDays (1-5 = Mon-Fri).
  const day = d.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  return atMidnight(monday);
}

/**
 * Daily send cap for one mailbox on a given date.
 * 0 if warmup has not started, the mailbox is paused, or today is not a
 * configured send day. Otherwise the ramp value for the number of full
 * warmup weeks completed, capped at maxPerMailboxPerDay.
 */
export function dailyCapForMailbox(
  warmupStarted: string | null,
  today: Date,
  cfg: OutboundConfig,
  paused = false,
  providerCap: number | null = null
): number {
  if (!warmupStarted || paused) return 0;
  if (providerCap !== null && providerCap <= 0) return 0;

  const todayMid = atMidnight(today);
  const dow = todayMid.getDay();
  if (!(cfg.sendDays as readonly number[]).includes(dow)) return 0;

  const start = atMidnight(parseLocalDate(warmupStarted));
  const daysSinceStart = Math.floor((todayMid.getTime() - start.getTime()) / DAY_MS);
  if (daysSinceStart < 0) return 0; // warmup starts in the future

  const weeksCompleted = Math.floor(daysSinceStart / 7);
  const ramp = cfg.warmupRampPerMailbox as readonly number[];
  const idx = Math.min(weeksCompleted, ramp.length - 1);
  const rampValue = ramp[idx] ?? 0;
  const capped = Math.min(rampValue, cfg.maxPerMailboxPerDay);
  return providerCap !== null ? Math.min(capped, providerCap) : capped;
}

/**
 * Sendable capacity across all mailboxes for the calendar week containing
 * `today`, summed day by day so a warmup boundary crossing mid-week is
 * reflected correctly (not just today's cap x number of send days).
 */
export function weeklyCapacity(mailboxes: MailboxRamp[], today: Date, cfg: OutboundConfig): number {
  const monday = startOfWeek(today);
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    for (const mb of mailboxes) {
      total += dailyCapForMailbox(mb.warmupStarted, d, cfg, mb.paused, mb.dailyCap ?? null);
    }
  }
  return total;
}

/**
 * How many fully-warmed mailboxes are needed to sustain weeklyTarget.
 * Full ramp per mailbox is maxPerMailboxPerDay x number of send days per week
 * (e.g. 40/day x 5 days = 200/mailbox/week, so 1,500/week needs 8 mailboxes).
 */
export function mailboxesNeededFor(weeklyTarget: number, cfg: OutboundConfig): number {
  const perMailboxAtFullRamp = cfg.maxPerMailboxPerDay * cfg.sendDays.length;
  if (perMailboxAtFullRamp <= 0) return 0;
  return Math.ceil(weeklyTarget / perMailboxAtFullRamp);
}

export type WeekProjection = {
  weekIndex: number; // 0 = the week containing `today`
  weekStart: string; // ISO date of the Monday
  capacity: number;
  meetsTarget: boolean;
};

/**
 * Week-by-week sendable capacity for the given mailboxes, starting with the
 * week containing `today`, so the UI can show exactly when (if ever) the
 * weekly target becomes reachable at the current mailbox count.
 */
export function projection(
  mailboxes: MailboxRamp[],
  cfg: OutboundConfig,
  weeks: number,
  now: Date = new Date()
): WeekProjection[] {
  const out: WeekProjection[] = [];
  const monday0 = startOfWeek(now);
  for (let w = 0; w < weeks; w++) {
    const weekStart = new Date(monday0);
    weekStart.setDate(monday0.getDate() + w * 7);
    const capacity = weeklyCapacity(mailboxes, weekStart, cfg);
    out.push({
      weekIndex: w,
      weekStart: weekStart.toISOString().slice(0, 10),
      capacity,
      meetsTarget: capacity >= cfg.weeklyTarget,
    });
  }
  return out;
}
