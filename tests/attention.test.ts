import { describe, it, expect } from "vitest";
import { attention, attentionSummary, summaryText, QUIET_DAYS } from "../app/lib/attention";
import { docSummary } from "../app/lib/documentKinds";

const CLOSED = ["Closed", "Passed"];
const TODAY = "2026-09-26";

describe("attention", () => {
  it("flags an overdue next step with the day count and wins over quiet", () => {
    const a = attention({ stage: "NDA", next_step_due: "2026-09-20", last_interaction_at: "2026-08-01 10:00:00" }, CLOSED, TODAY);
    expect(a.overdueDays).toBe(6);
    expect(a.quiet).toBe(true);
    expect(a.label).toEqual({ kind: "overdue", text: "Overdue 6 days", tone: "stop" });
  });

  it("says 1 day, not 1 days", () => {
    expect(attention({ stage: "NDA", next_step_due: "2026-09-25" }, CLOSED, TODAY).label?.text).toBe("Overdue 1 day");
  });

  it("flags due today", () => {
    const a = attention({ stage: "Engaged", next_step_due: TODAY, last_interaction_at: "2026-09-25 09:00:00" }, CLOSED, TODAY);
    expect(a.dueToday).toBe(true);
    expect(a.overdueDays).toBeNull();
    expect(a.label).toEqual({ kind: "due-today", text: "Due today", tone: "info" });
  });

  it("a future due date is not a flag", () => {
    const a = attention({ stage: "Engaged", next_step_due: "2026-10-02", last_interaction_at: "2026-09-24 09:00:00" }, CLOSED, TODAY);
    expect(a.label).toBeNull();
  });

  it(`goes quiet at ${QUIET_DAYS} days without an interaction`, () => {
    expect(attention({ stage: "Contacted", last_interaction_at: "2026-09-06 12:00:00" }, CLOSED, TODAY).label).toBeNull();
    const a = attention({ stage: "Contacted", last_interaction_at: "2026-09-05 12:00:00" }, CLOSED, TODAY);
    expect(a.quietDays).toBe(21);
    expect(a.label).toEqual({ kind: "quiet", text: "Quiet 21 days", tone: "warn" });
  });

  it("falls back to any activity, then the creation date", () => {
    expect(attention({ stage: "Sourced", last_interaction_at: null, last_activity_at: "2026-08-23 08:00:00" }, CLOSED, TODAY).quietDays).toBe(34);
    expect(attention({ stage: "Sourced", created_at: "2026-09-20 08:00:00" }, CLOSED, TODAY).quietDays).toBe(6);
    const none = attention({ stage: "Sourced" }, CLOSED, TODAY);
    expect(none.quietDays).toBeNull();
    expect(none.label).toBeNull();
  });

  it("never flags closed or passed deals and marks them closed", () => {
    const a = attention({ stage: "Passed", next_step_due: "2026-01-01", last_interaction_at: "2025-01-01 00:00:00" }, CLOSED, TODAY);
    expect(a.closed).toBe(true);
    expect(a.quiet).toBe(false);
    expect(a.overdueDays).toBeNull();
    expect(a.label).toBeNull();
  });

  it("marks LOI as a late stage", () => {
    expect(attention({ stage: "LOI" }, CLOSED, TODAY).late).toBe(true);
    expect(attention({ stage: "NDA" }, CLOSED, TODAY).late).toBe(false);
  });

  it("ignores unreadable dates", () => {
    const a = attention({ stage: "NDA", next_step_due: "soon", last_interaction_at: "" }, CLOSED, TODAY);
    expect(a.label).toBeNull();
  });
});

describe("attentionSummary", () => {
  it("counts each deal under its one label and writes the line", () => {
    const items = [
      attention({ stage: "NDA", next_step_due: "2026-09-20", last_interaction_at: "2026-01-01 00:00:00" }, CLOSED, TODAY),
      attention({ stage: "NDA", next_step_due: "2026-09-21" }, CLOSED, TODAY),
      attention({ stage: "NDA", last_interaction_at: "2026-08-01 00:00:00" }, CLOSED, TODAY),
      attention({ stage: "NDA", next_step_due: TODAY }, CLOSED, TODAY),
      attention({ stage: "Passed", last_interaction_at: "2025-01-01 00:00:00" }, CLOSED, TODAY),
    ];
    const s = attentionSummary(items);
    expect(s).toEqual({ overdue: 2, quiet: 1, dueToday: 1 });
    expect(summaryText(s)).toBe("2 overdue, 1 quiet, 1 due today");
    expect(summaryText({ overdue: 0, quiet: 0, dueToday: 0 })).toBeNull();
  });
});

describe("docSummary", () => {
  it("summarises live documents one line per kind", () => {
    const docs = [
      { kind: "cim", version: 3 },
      ...Array.from({ length: 6 }, () => ({ kind: "nda", version: 1 })),
      { kind: "engagement_letter", version: 1 },
      { kind: "teaser", version: 1, archived_at: "2026-09-01 00:00:00" },
    ];
    expect(docSummary(docs)).toBe("Engagement letter · 6 NDAs · CIM v3");
  });
  it("is null with nothing live", () => {
    expect(docSummary([])).toBeNull();
    expect(docSummary([{ kind: "cim", version: 1, archived_at: "2026-01-01" }])).toBeNull();
  });
});
