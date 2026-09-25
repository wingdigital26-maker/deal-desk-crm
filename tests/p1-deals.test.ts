// P1 DEALS: money and motion. Deal economics math + PATCH validation, the
// deal team API, and the touch-cadence feed behind the Today page.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { harness, cookieMock, freshApp, params, jsonReq, cleanup, type App } from "./_harness";
import { expectedFee, weightedFee, effectiveProbability, pipelineSummary, parseMoney, formatMoney, quarterOf, evFromMultiple, multipleOf } from "../app/lib/dealMath";

vi.mock("next/headers", () => cookieMock());

const cfg = { stageProbability: { Engaged: 40, LOI: 75, Closed: 100, Passed: 0 } as Record<string, number>, closedStages: ["Closed", "Passed"] };

describe("dealMath", () => {
  it("expected fee is retainer plus EV x success fee", () => {
    expect(expectedFee({ stage: "Engaged", retainer: 50_000, enterprise_value: 20_000_000, success_fee_pct: 3 })).toBe(650_000);
  });
  it("retainer alone counts; no inputs at all is null, never zero", () => {
    expect(expectedFee({ stage: "Engaged", retainer: 25_000 })).toBe(25_000);
    expect(expectedFee({ stage: "Engaged", enterprise_value: 10_000_000 })).toBeNull();
    expect(expectedFee({ stage: "Engaged" })).toBeNull();
  });
  it("uses the deal's own probability, else the stage default, and says which", () => {
    expect(effectiveProbability({ stage: "Engaged", probability: 60 }, cfg)).toEqual({ value: 60, source: "deal" });
    expect(effectiveProbability({ stage: "Engaged" }, cfg)).toEqual({ value: 40, source: "stage" });
    expect(weightedFee({ stage: "LOI", retainer: 100_000 }, cfg)).toBe(75_000);
  });
  it("pipeline summary excludes closed and passed deals and buckets by quarter", () => {
    const s = pipelineSummary(
      [
        { stage: "Engaged", retainer: 100_000, probability: 50, expected_close: "2026-11-15", enterprise_value: 5_000_000 },
        { stage: "LOI", retainer: 200_000, expected_close: "2026-12-01" },
        { stage: "Engaged" },
        { stage: "Closed", retainer: 999_999 },
        { stage: "Passed", retainer: 999_999 },
      ],
      cfg
    );
    expect(s.openCount).toBe(3);
    expect(s.withFeeCount).toBe(2);
    expect(s.expectedFees).toBe(300_000);
    expect(s.weightedFees).toBe(50_000 + 150_000);
    expect(s.stageDefaultCount).toBe(1);
    expect(s.totalEnterpriseValue).toBe(5_000_000);
    expect(s.byQuarter).toEqual([{ quarter: "2026 Q4", count: 2, expected: 300_000, weighted: 200_000 }]);
  });
  it("a new EBITDA reprices EV and every fee at the same multiple", () => {
    const m = multipleOf(40_000_000, 5_000_000);
    expect(m).toBe(8);
    const ev = evFromMultiple(6_000_000, m);
    expect(ev).toBe(48_000_000);
    const deal = { stage: "Engaged", retainer: 50_000, success_fee_pct: 3, enterprise_value: ev, probability: 50 };
    expect(expectedFee(deal)).toBe(50_000 + 1_440_000);
    expect(weightedFee(deal, cfg)).toBe(745_000);
    expect(evFromMultiple(null, 8)).toBeNull();
    expect(multipleOf(10, 0)).toBeNull();
  });
  it("parses money the way bankers type it", () => {
    expect(parseMoney("12.5M")).toBe(12_500_000);
    expect(parseMoney("$750k")).toBe(750_000);
    expect(parseMoney("1,200,000")).toBe(1_200_000);
    expect(parseMoney("2bn")).toBe(2_000_000_000);
    expect(parseMoney("")).toBeNull();
    expect(Number.isNaN(parseMoney("lots"))).toBe(true);
    expect(formatMoney(12_500_000)).toBe("$12.5M");
    expect(quarterOf("2027-02-10")).toBe("2027 Q1");
  });
});

describe("deal economics PATCH", () => {
  let app: App;
  let route: typeof import("../app/api/deals/[id]/route");
  beforeEach(async () => {
    vi.resetModules();
    app = await freshApp();
    route = await import("../app/api/deals/[id]/route");
  });
  afterEach(cleanup);

  it("saves every economics field and audits it", async () => {
    await app.signIn("member");
    const id = app.deal(app.company());
    const res = await route.PATCH(
      jsonReq(`/api/deals/${id}`, "PATCH", {
        retainer: 50000,
        success_fee_pct: 3.5,
        ebitda: 4000000,
        enterprise_value: 28000000,
        probability: 60,
        expected_close: "2027-03-31",
        fee_terms: "Retainer credited against success fee",
      }),
      params(id)
    );
    expect(res.status).toBe(200);
    const row = app.db.prepare("SELECT * FROM deals WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.success_fee_pct).toBe(3.5);
    expect(row.enterprise_value).toBe(28000000);
    expect(row.expected_close).toBe("2027-03-31");
    const audit = app.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'deal.update'").get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json).probability).toBe(60);
  });

  it("rejects out-of-range values with a 400 naming the field", async () => {
    await app.signIn();
    const id = app.deal(app.company());
    for (const [key, val] of [
      ["success_fee_pct", 120],
      ["probability", -5],
      ["retainer", -1],
      ["enterprise_value", "lots"],
      ["expected_close", "2027-02-30"],
    ] as const) {
      const res = await route.PATCH(jsonReq(`/api/deals/${id}`, "PATCH", { [key]: val }), params(id));
      expect(res.status, key).toBe(400);
      expect((await res.json()).field).toBe(key);
    }
  });

  it("clears a value with null", async () => {
    await app.signIn();
    const id = app.deal(app.company());
    await route.PATCH(jsonReq(`/api/deals/${id}`, "PATCH", { ebitda: 100 }), params(id));
    await route.PATCH(jsonReq(`/api/deals/${id}`, "PATCH", { ebitda: null }), params(id));
    expect((app.db.prepare("SELECT ebitda FROM deals WHERE id = ?").get(id) as { ebitda: number | null }).ebitda).toBeNull();
  });
});

describe("deal team API", () => {
  let app: App;
  let team: typeof import("../app/api/deals/[id]/team/route");
  beforeEach(async () => {
    vi.resetModules();
    app = await freshApp();
    team = await import("../app/api/deals/[id]/team/route");
  });
  afterEach(cleanup);

  it("adds, re-roles and removes a member, auditing each step", async () => {
    const me = await app.signIn("owner", "Dana Lead");
    const id = app.deal(app.company());
    let res = await team.POST(jsonReq(`/api/deals/${id}/team`, "POST", { user_id: me, role: "lead" }), params(id));
    expect(res.status).toBe(201);
    expect((await res.json()).items).toMatchObject([{ user_id: me, role: "lead", name: "Dana Lead" }]);

    res = await team.PATCH(jsonReq(`/api/deals/${id}/team`, "PATCH", { user_id: me, role: "coverage" }), params(id));
    expect((await res.json()).items[0].role).toBe("coverage");

    res = await team.DELETE(jsonReq(`/api/deals/${id}/team?user_id=${me}`, "DELETE"), params(id));
    expect((await res.json()).items).toEqual([]);
    const actions = (app.db.prepare("SELECT action FROM audit_log ORDER BY id").all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(["deal.team.add", "deal.team.role", "deal.team.remove"]);
  });

  it("409 on a duplicate member, 400 on an unknown user or role", async () => {
    const me = await app.signIn();
    const id = app.deal(app.company());
    await team.POST(jsonReq(`/api/deals/${id}/team`, "POST", { user_id: me }), params(id));
    expect((await team.POST(jsonReq(`/api/deals/${id}/team`, "POST", { user_id: me }), params(id))).status).toBe(409);
    expect((await team.POST(jsonReq(`/api/deals/${id}/team`, "POST", { user_id: 9999 }), params(id))).status).toBe(400);
    expect((await team.POST(jsonReq(`/api/deals/${id}/team`, "POST", { user_id: me, role: "boss" }), params(id))).status).toBe(400);
  });

  it("401 when signed out", async () => {
    const id = app.deal(app.company());
    harness.token = undefined;
    expect((await team.GET(jsonReq(`/api/deals/${id}/team`, "GET"), params(id))).status).toBe(401);
  });
});

describe("touch cadence", () => {
  let app: App;
  let cadence: typeof import("../app/lib/cadence");
  let contactRoute: typeof import("../app/api/contacts/[id]/route");
  let activities: typeof import("../app/api/activities/route");
  beforeEach(async () => {
    vi.resetModules();
    app = await freshApp();
    cadence = await import("../app/lib/cadence");
    contactRoute = await import("../app/api/contacts/[id]/route");
    activities = await import("../app/api/activities/route");
  });
  afterEach(cleanup);

  it("lists a 30-day cadence touched 40 days ago, not one touched yesterday", async () => {
    await app.signIn();
    const stale = app.contact({ touch_every_days: 30 });
    const fresh = app.contact({ touch_every_days: 30 });
    app.contact(); // no cadence: never listed
    app.db.prepare("INSERT INTO activities (kind, contact_id, created_at) VALUES ('call', ?, datetime('now', '-40 days'))").run(stale);
    app.db.prepare("INSERT INTO activities (kind, contact_id, created_at) VALUES ('call', ?, datetime('now', '-1 days'))").run(fresh);
    const due = cadence.relationshipsDue();
    expect(due.map((r) => r.id)).toEqual([stale]);
    expect(due[0].days_since).toBe(40);
  });

  it("a never-touched contact with a cadence is due; logging a touch clears it", async () => {
    await app.signIn();
    const c = app.contact({ touch_every_days: 14 });
    expect(cadence.relationshipsDue().map((r) => r.id)).toEqual([c]);
    const res = await activities.POST(jsonReq("/api/activities", "POST", { kind: "call", body: "Touch logged", contact_id: c }));
    expect(res.status).toBe(201);
    expect(cadence.relationshipsDue()).toEqual([]);
  });

  it("imports do not count as a touch; do-not-contact is never listed", async () => {
    await app.signIn();
    const c = app.contact({ touch_every_days: 14 });
    app.db.prepare("INSERT INTO activities (kind, contact_id) VALUES ('import', ?)").run(c);
    expect(cadence.relationshipsDue().map((r) => r.id)).toEqual([c]);
    app.contact({ touch_every_days: 14, do_not_contact: 1 });
    expect(cadence.relationshipsDue().length).toBe(1);
  });

  it("PATCH sets and clears the cadence, rejecting nonsense", async () => {
    await app.signIn();
    const c = app.contact();
    expect((await contactRoute.PATCH(jsonReq(`/api/contacts/${c}`, "PATCH", { touch_every_days: 90 }), params(c))).status).toBe(200);
    expect((app.db.prepare("SELECT touch_every_days FROM contacts WHERE id = ?").get(c) as { touch_every_days: number }).touch_every_days).toBe(90);
    expect((await contactRoute.PATCH(jsonReq(`/api/contacts/${c}`, "PATCH", { touch_every_days: 0 }), params(c))).status).toBe(400);
    await contactRoute.PATCH(jsonReq(`/api/contacts/${c}`, "PATCH", { touch_every_days: null }), params(c));
    expect((app.db.prepare("SELECT touch_every_days FROM contacts WHERE id = ?").get(c) as { touch_every_days: number | null }).touch_every_days).toBeNull();
  });
});
