import { describe, it, expect } from "vitest";
import { checkDailySpend, sumCreditsFromAuditRows, defaultDailyCap } from "../app/lib/apollo/spend";

describe("checkDailySpend", () => {
  it("allows spend under the cap", () => {
    const result = checkDailySpend(10, 20, 100);
    expect(result.ok).toBe(true);
  });

  it("allows spend exactly at the cap", () => {
    const result = checkDailySpend(80, 20, 100);
    expect(result.ok).toBe(true);
  });

  it("refuses spend that would cross the cap", () => {
    const result = checkDailySpend(90, 20, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/110/);
      expect(result.reason).toMatch(/100/);
    }
  });

  it("allows a zero-credit request even when already over cap", () => {
    const result = checkDailySpend(500, 0, 100);
    expect(result.ok).toBe(true);
  });
});

describe("sumCreditsFromAuditRows", () => {
  it("sums creditsUsed out of detail_json rows", () => {
    const rows = [
      { detail_json: JSON.stringify({ creditsUsed: 5 }) },
      { detail_json: JSON.stringify({ creditsUsed: 3 }) },
    ];
    expect(sumCreditsFromAuditRows(rows)).toBe(8);
  });

  it("ignores malformed or missing creditsUsed", () => {
    const rows = [
      { detail_json: "not json" },
      { detail_json: JSON.stringify({ other: 1 }) },
      { detail_json: JSON.stringify({ creditsUsed: "5" }) },
      { detail_json: JSON.stringify({ creditsUsed: 4 }) },
    ];
    expect(sumCreditsFromAuditRows(rows)).toBe(4);
  });

  it("returns 0 for an empty list", () => {
    expect(sumCreditsFromAuditRows([])).toBe(0);
  });
});

describe("defaultDailyCap", () => {
  it("defaults to 100 when unset", () => {
    delete process.env.APOLLO_DAILY_CREDIT_CAP;
    expect(defaultDailyCap()).toBe(100);
  });

  it("reads a positive integer override", () => {
    process.env.APOLLO_DAILY_CREDIT_CAP = "250";
    expect(defaultDailyCap()).toBe(250);
    delete process.env.APOLLO_DAILY_CREDIT_CAP;
  });

  it("falls back to 100 for zero, negative, or non-numeric values", () => {
    for (const v of ["0", "-5", "abc", ""]) {
      process.env.APOLLO_DAILY_CREDIT_CAP = v;
      expect(defaultDailyCap()).toBe(100);
    }
    delete process.env.APOLLO_DAILY_CREDIT_CAP;
  });
});
