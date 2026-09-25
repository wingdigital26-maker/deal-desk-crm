import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dailyCapForMailbox,
  weeklyCapacity,
  mailboxesNeededFor,
  projection,
  type OutboundConfig,
  type MailboxRamp,
} from "../app/lib/outbound/ramp";

const cfg: OutboundConfig = {
  warmupRampPerMailbox: [5, 10, 15, 20, 30, 40],
  maxPerMailboxPerDay: 40,
  sendDays: [1, 2, 3, 4, 5],
  weeklyTarget: 1500,
};

// A known Monday and the following days, used to control day-of-week deterministically.
const MON = new Date(2026, 8, 21); // 2026-09-21 is a Monday
// A Tuesday start, used for the day-6/day-13 boundary checks so that "6 days
// later" and "13 days later" land on a weekday (Monday) instead of a weekend,
// since dailyCapForMailbox also gates on sendDays.
const TUE = new Date(2026, 8, 22); // 2026-09-22 is a Tuesday
function daysAfter(base: Date, n: number) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

describe("dailyCapForMailbox", () => {
  it("is 0 when warmup has not started", () => {
    expect(dailyCapForMailbox(null, MON, cfg)).toBe(0);
  });

  it("is 0 when paused, even mid-ramp", () => {
    expect(dailyCapForMailbox(MON.toISOString(), MON, cfg, true)).toBe(0);
  });

  it("is week-0 ramp value on day 0 of warmup", () => {
    expect(dailyCapForMailbox(MON.toISOString(), MON, cfg)).toBe(5);
  });

  it("is still week-0 ramp value on day 6", () => {
    // Start Tuesday so day 6 lands on the following Monday (a send day).
    const today = daysAfter(TUE, 6);
    expect(dailyCapForMailbox(TUE.toISOString(), today, cfg)).toBe(5);
  });

  it("moves to week-1 ramp value on day 7", () => {
    const today = daysAfter(MON, 7);
    expect(dailyCapForMailbox(MON.toISOString(), today, cfg)).toBe(10);
  });

  it("is still week-1 ramp value on day 13", () => {
    // Start Tuesday so day 13 lands on the following-following Monday (a send day).
    const today = daysAfter(TUE, 13);
    expect(dailyCapForMailbox(TUE.toISOString(), today, cfg)).toBe(10);
  });

  it("moves to week-2 ramp value on day 14", () => {
    const today = daysAfter(MON, 14);
    expect(dailyCapForMailbox(MON.toISOString(), today, cfg)).toBe(15);
  });

  it("caps at maxPerMailboxPerDay once past the ramp table (the ceiling)", () => {
    const farFuture = daysAfter(MON, 365);
    const cap = dailyCapForMailbox(MON.toISOString(), farFuture, cfg);
    expect(cap).toBe(40);
    expect(cap).toBeLessThanOrEqual(cfg.maxPerMailboxPerDay);
  });

  it("is 0 on a weekend even after full warmup", () => {
    // Sept 26, 2026 is a Saturday; Sept 27 is a Sunday.
    const saturday = new Date(2026, 8, 26);
    const sunday = new Date(2026, 8, 27);
    expect(dailyCapForMailbox(MON.toISOString(), saturday, cfg)).toBe(0);
    expect(dailyCapForMailbox(MON.toISOString(), sunday, cfg)).toBe(0);
  });

  it("is 0 when warmup starts in the future", () => {
    const future = daysAfter(MON, 30);
    expect(dailyCapForMailbox(future.toISOString(), MON, cfg)).toBe(0);
  });
});

describe("weeklyCapacity", () => {
  it("sums correctly for a single fully-ramped mailbox (5 send days x 40)", () => {
    const mailboxes: MailboxRamp[] = [{ warmupStarted: daysAfter(MON, -365).toISOString() }];
    const total = weeklyCapacity(mailboxes, MON, cfg);
    expect(total).toBe(40 * 5);
  });

  it("sums correctly across multiple mailboxes at different warmup stages", () => {
    const mailboxes: MailboxRamp[] = [
      { warmupStarted: MON.toISOString() }, // week 0 => 5/day
      { warmupStarted: daysAfter(MON, -365).toISOString() }, // full ramp => 40/day
    ];
    const total = weeklyCapacity(mailboxes, MON, cfg);
    expect(total).toBe(5 * 5 + 40 * 5);
  });

  it("excludes paused mailboxes", () => {
    const mailboxes: MailboxRamp[] = [{ warmupStarted: daysAfter(MON, -365).toISOString(), paused: true }];
    expect(weeklyCapacity(mailboxes, MON, cfg)).toBe(0);
  });

  it("reflects a warmup boundary crossed mid-week, not just today's cap x 5", () => {
    // Mailbox starts on Thursday of this week: Mon/Tue/Wed at cap 0 (not started yet),
    // Thu/Fri at week-0 cap (5). Weekend contributes 0 regardless.
    const thursday = daysAfter(MON, 3);
    const mailboxes: MailboxRamp[] = [{ warmupStarted: thursday.toISOString() }];
    const total = weeklyCapacity(mailboxes, MON, cfg);
    expect(total).toBe(5 * 2); // Thu + Fri only
  });
});

describe("mailboxesNeededFor", () => {
  it("is 8 for the shipped 1500/week target", () => {
    expect(mailboxesNeededFor(1500, cfg)).toBe(8);
  });

  it("rounds up for a target that does not divide evenly", () => {
    // 40*5 = 200/mailbox/week; 1501 needs one more than exactly 8 mailboxes would give (1600).
    expect(mailboxesNeededFor(1501, cfg)).toBe(8);
    expect(mailboxesNeededFor(1601, cfg)).toBe(9);
  });
});

describe("projection", () => {
  // projection() ignores any "today" argument and always reads new Date() internally
  // (it has no today parameter at all), so these tests must pin the system clock to
  // MON to get a deterministic week 0. See REPORTED BUG note in the final report.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(MON);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaches the weekly target in the expected week for 8 mailboxes started the same day", () => {
    const mailboxes: MailboxRamp[] = Array.from({ length: 8 }, () => ({ warmupStarted: MON.toISOString() }));
    const weeks = projection(mailboxes, cfg, 8);
    // Ramp: week0=5,1=10,2=15,3=20,4=30,5=40(ceiling). 8 mailboxes x 40 x 5 days = 1600 >= 1500 at week 5.
    const firstMeeting = weeks.find((w) => w.meetsTarget);
    expect(firstMeeting).toBeDefined();
    expect(firstMeeting?.weekIndex).toBe(5);
    for (const w of weeks.slice(0, 5)) {
      expect(w.meetsTarget).toBe(false);
    }
  });

  it("never reaches the weekly target with only 7 mailboxes", () => {
    const mailboxes: MailboxRamp[] = Array.from({ length: 7 }, () => ({ warmupStarted: MON.toISOString() }));
    const weeks = projection(mailboxes, cfg, 12);
    // Full ramp for 7 mailboxes: 7 x 40 x 5 = 1400 < 1500, forever.
    expect(weeks.every((w) => !w.meetsTarget)).toBe(true);
  });
});
