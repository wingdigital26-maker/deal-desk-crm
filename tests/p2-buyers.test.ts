// P2 BUYERS: the buyer log API, stage history, revisions, cross-deal memory
// and buyer profiles, against a real temp database (SPEC_BUYER_LOG + VERIFY fixes).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieMock, freshApp, params, jsonReq, cleanup, harness, type App } from "./_harness";
import { nextStage, prevStage, hasTerms, FORWARD_STAGES } from "../app/lib/buyerStages";

vi.mock("next/headers", () => cookieMock());

let app: App;
let list: typeof import("../app/api/deal-buyers/route");
let one: typeof import("../app/api/deal-buyers/[id]/route");
let bulk: typeof import("../app/api/deal-buyers/bulk-stage/route");
let history: typeof import("../app/api/companies/[id]/buyer-history/route");
let profile: typeof import("../app/api/companies/[id]/buyer-profile/route");

beforeEach(async () => {
  vi.resetModules();
  app = await freshApp();
  list = await import("../app/api/deal-buyers/route");
  one = await import("../app/api/deal-buyers/[id]/route");
  bulk = await import("../app/api/deal-buyers/bulk-stage/route");
  history = await import("../app/api/companies/[id]/buyer-history/route");
  profile = await import("../app/api/companies/[id]/buyer-profile/route");
});
afterEach(cleanup);

async function setup(nBuyers = 2) {
  await app.signIn();
  const seller = app.company("Seller Co");
  const dealId = app.deal(seller);
  const buyers = Array.from({ length: nBuyers }, (_, i) => app.company(`Buyer ${i}`));
  const res = await list.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: dealId, buyers: buyers.map((b) => ({ buyer_company_id: b })) }));
  const body = await res.json();
  return { dealId, buyers, rows: body.created as number[] };
}
const patch = (id: number, body: unknown) => one.PATCH(jsonReq(`/api/deal-buyers/${id}`, "PATCH", body), params(id));
const get = async (dealId: number) => (await list.GET(jsonReq(`/api/deal-buyers?deal_id=${dealId}`, "GET"))).json();

describe("schema", () => {
  it("one row per (deal, buyer) and a CHECK on stage", async () => {
    const { dealId, buyers } = await setup(1);
    expect(() => app.db.prepare("INSERT INTO deal_buyers (deal_id, buyer_company_id) VALUES (?, ?)").run(dealId, buyers[0])).toThrow(/UNIQUE/);
    const other = app.company();
    expect(() => app.db.prepare("INSERT INTO deal_buyers (deal_id, buyer_company_id, stage) VALUES (?, ?, 'made_up')").run(dealId, other)).toThrow(/CHECK/);
  });
  it("stage history cannot be cascaded away by deleting a buyer row", async () => {
    const { rows } = await setup(1);
    expect(() => app.db.prepare("DELETE FROM deal_buyers WHERE id = ?").run(rows[0])).toThrow(/FOREIGN KEY/);
  });
});

describe("adding buyers", () => {
  it("bulk add reports created and skipped separately and never fails the batch", async () => {
    await app.signIn();
    const dealId = app.deal(app.company());
    const [a, b] = [app.company(), app.company()];
    const res = await list.POST(
      jsonReq("/api/deal-buyers", "POST", { deal_id: dealId, buyers: [{ buyer_company_id: a }, { buyer_company_id: a }, { buyer_company_id: b }, { buyer_company_id: 99999 }] })
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.created.length).toBe(2);
    expect(body.skipped.map((s: { reason: string }) => s.reason)).toEqual(["Listed twice in this batch", "Unknown company"]);
    const again = await (await list.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: dealId, buyers: [{ buyer_company_id: a }] }))).json();
    expect(again.skipped[0].reason).toBe("Already on this buyer log");
  });
  it("a new buyer starts at teaser_sent with the milestone stamped and one history row", async () => {
    const { rows } = await setup(1);
    const row = app.db.prepare("SELECT stage, teaser_sent_at FROM deal_buyers WHERE id = ?").get(rows[0]) as { stage: string; teaser_sent_at: string };
    expect(row.stage).toBe("teaser_sent");
    expect(row.teaser_sent_at).toBeTruthy();
    expect(app.db.prepare("SELECT COUNT(*) n FROM deal_buyer_stage_history WHERE deal_buyer_id = ?").get(rows[0])).toEqual({ n: 1 });
  });
  it("401 when signed out", async () => {
    harness.token = undefined;
    expect((await list.GET(jsonReq("/api/deal-buyers?deal_id=1", "GET"))).status).toBe(401);
  });
});

describe("stage changes", () => {
  it("declined without a reason is a 400; with one it keeps where the buyer dropped out", async () => {
    const { rows } = await setup(1);
    await patch(rows[0], { stage: "cim_sent" });
    expect((await patch(rows[0], { stage: "declined" })).status).toBe(400);
    const res = await patch(rows[0], { stage: "declined", decline_reason: "Valuation gap" });
    const { item } = await res.json();
    expect(item.stage).toBe("declined");
    expect(item.declined_from_stage).toBe("cim_sent");
    expect(item.decline_reason).toBe("Valuation gap");
  });
  it("writes one history row per move and stamps a milestone once, never overwriting it", async () => {
    const { rows } = await setup(1);
    const id = rows[0];
    app.db.prepare("DELETE FROM deal_buyer_stage_history WHERE deal_buyer_id = ?").run(id);
    await patch(id, { stage: "nda_signed" });
    expect((app.db.prepare("SELECT COUNT(*) n FROM deal_buyer_stage_history WHERE deal_buyer_id = ?").get(id) as { n: number }).n).toBe(1);
    app.db.prepare("UPDATE deal_buyers SET nda_signed_at = '2026-01-01 00:00:00' WHERE id = ?").run(id);
    await patch(id, { stage: "cim_sent" });
    await patch(id, { stage: "nda_signed" });
    const row = app.db.prepare("SELECT nda_signed_at FROM deal_buyers WHERE id = ?").get(id) as { nda_signed_at: string };
    expect(row.nda_signed_at).toBe("2026-01-01 00:00:00");
    expect((app.db.prepare("SELECT COUNT(*) n FROM deal_buyer_stage_history WHERE deal_buyer_id = ?").get(id) as { n: number }).n).toBe(3);
  });
  it("moving to the same stage writes nothing", async () => {
    const { rows } = await setup(1);
    await patch(rows[0], { stage: "teaser_sent" });
    expect((app.db.prepare("SELECT COUNT(*) n FROM deal_buyer_stage_history").get() as { n: number }).n).toBe(1);
  });
  it("bulk decline needs a reason for the whole batch; bulk move is one audit row", async () => {
    const { rows } = await setup(3);
    const noReason = await bulk.POST(jsonReq("/api/deal-buyers/bulk-stage", "POST", { ids: rows, stage: "declined" }));
    expect(noReason.status).toBe(400);
    const ok = await bulk.POST(jsonReq("/api/deal-buyers/bulk-stage", "POST", { ids: rows, stage: "nda_sent" }));
    expect((await ok.json()).moved).toEqual(rows);
    expect((app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'deal_buyer.bulk_stage_change'").get() as { n: number }).n).toBe(1);
  });
  it("a bulk move with one bad id rolls the whole batch back", async () => {
    const { rows } = await setup(2);
    const res = await bulk.POST(jsonReq("/api/deal-buyers/bulk-stage", "POST", { ids: [...rows, 424242], stage: "nda_sent" }));
    expect(res.status).toBe(404);
    const stages = app.db.prepare("SELECT stage FROM deal_buyers").all() as { stage: string }[];
    expect(stages.every((s) => s.stage === "teaser_sent")).toBe(true);
  });
  it("funnel counts sum to the number of buyers; reached counts every stage a buyer got through", async () => {
    const { dealId, rows } = await setup(3);
    await patch(rows[0], { stage: "ioi" });
    await patch(rows[1], { stage: "nda_signed" });
    await patch(rows[1], { stage: "declined", decline_reason: "Too small" });
    const body = await get(dealId);
    const total = Object.values(body.funnel as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(body.items.length);
    expect(body.funnel.declined).toBe(1);
    expect(body.reached.teaser_sent).toBe(3);
    expect(body.reached.nda_signed).toBe(2);
    expect(body.reached.ioi).toBe(1);
  });
});

describe("terms and revisions", () => {
  it("term edits write old and new values; IOI low above high is refused", async () => {
    const { rows } = await setup(1);
    const id = rows[0];
    await patch(id, { ioi_low: 20_000_000, ioi_high: 24_000_000 });
    await patch(id, { ioi_high: 26_000_000 });
    const revs = app.db.prepare("SELECT field, old_value, new_value FROM deal_buyer_revisions WHERE deal_buyer_id = ? ORDER BY id").all(id);
    expect(revs).toEqual([
      { field: "ioi_low", old_value: null, new_value: "20000000" },
      { field: "ioi_high", old_value: null, new_value: "24000000" },
      { field: "ioi_high", old_value: "24000000", new_value: "26000000" },
    ]);
    expect((await patch(id, { ioi_low: 30_000_000 })).status).toBe(400);
    expect((await patch(id, { cash_at_close_pct: 140 })).status).toBe(400);
  });
  it("remove is soft: the buyer leaves the log but history and revisions stay", async () => {
    const { dealId, rows } = await setup(1);
    const res = await one.DELETE(jsonReq(`/api/deal-buyers/${rows[0]}`, "DELETE"), params(rows[0]));
    expect(res.status).toBe(200);
    expect((await get(dealId)).items).toEqual([]);
    expect((app.db.prepare("SELECT COUNT(*) n FROM deal_buyer_stage_history").get() as { n: number }).n).toBe(1);
  });
});

describe("cross-deal buyer memory and profiles", () => {
  it("returns every deal this buyer was shown, newest first", async () => {
    await app.signIn();
    const buyer = app.company("Summit Partners Fund");
    const d1 = app.deal(app.company("Alpha Seller"));
    const d2 = app.deal(app.company("Beta Seller"));
    const r1 = await (await list.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: d1, buyers: [{ buyer_company_id: buyer }] }))).json();
    await patch(r1.created[0], { stage: "declined", decline_reason: "Outside thesis" });
    app.db.prepare("UPDATE deal_buyers SET updated_at = datetime('now', '-30 days') WHERE id = ?").run(r1.created[0]);
    await list.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: d2, buyers: [{ buyer_company_id: buyer }] }));
    const body = await (await history.GET(jsonReq(`/api/companies/${buyer}/buyer-history`, "GET"), params(buyer))).json();
    expect(body.items.map((r: { deal_id: number }) => r.deal_id)).toEqual([d2, d1]);
    expect(body.items[1].decline_reason).toBe("Outside thesis");
    expect(body.items[1].seller_name).toBe("Alpha Seller");
  });
  it("a company that was never a buyer returns an empty list, not an error", async () => {
    await app.signIn();
    const c = app.company();
    const res = await history.GET(jsonReq(`/api/companies/${c}/buyer-history`, "GET"), params(c));
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });
  it("profile upsert is idempotent per company and merges fields", async () => {
    await app.signIn();
    const c = app.company();
    await profile.PATCH(jsonReq(`/api/companies/${c}/buyer-profile`, "PATCH", { buyer_type: "pe", check_size_low: 5_000_000 }), params(c));
    const res = await profile.PATCH(jsonReq(`/api/companies/${c}/buyer-profile`, "PATCH", { check_size_high: 15_000_000 }), params(c));
    expect((await res.json()).profile).toMatchObject({ buyer_type: "pe", check_size_low: 5_000_000, check_size_high: 15_000_000 });
    expect((app.db.prepare("SELECT COUNT(*) n FROM buyer_profiles").get() as { n: number }).n).toBe(1);
    const bad = await profile.PATCH(jsonReq(`/api/companies/${c}/buyer-profile`, "PATCH", { check_size_low: 50_000_000 }), params(c));
    expect(bad.status).toBe(400);
    expect((await profile.PATCH(jsonReq(`/api/companies/${c}/buyer-profile`, "PATCH", { buyer_type: "hedge" }), params(c))).status).toBe(400);
  });
});

describe("stage helpers", () => {
  it("Advance and Back never land on declined", () => {
    expect(nextStage("mgmt_meeting")).toBe("loi");
    expect(nextStage("loi")).toBe("exclusivity");
    expect(nextStage("closed")).toBeNull();
    expect(nextStage("declined")).toBeNull();
    expect(prevStage("teaser_sent")).toBeNull();
    expect(FORWARD_STAGES).not.toContain("declined");
  });
  it("terms apply from IOI on, including a buyer who declined after bidding", () => {
    expect(hasTerms({ stage: "cim_sent" })).toBe(false);
    expect(hasTerms({ stage: "ioi" })).toBe(true);
    expect(hasTerms({ stage: "declined", declined_from_stage: "loi" })).toBe(true);
    expect(hasTerms({ stage: "declined", declined_from_stage: "nda_sent" })).toBe(false);
  });
});

describe("seller report", () => {
  it("CSV escapes a formula-looking buyer name; report funnel equals the buyer log funnel; XLSX is a zip", async () => {
    const report = await import("../app/api/deals/[id]/seller-report/route");
    await app.signIn();
    const dealId = app.deal(app.company("Seller"));
    const evil = app.company("=SUM(A1:A9)");
    const normal = app.company("Harbor Capital");
    await list.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: dealId, buyers: [{ buyer_company_id: evil }, { buyer_company_id: normal }] }));
    const csv = await (await report.GET(jsonReq(`/api/deals/${dealId}/seller-report?format=csv`, "GET"), params(dealId))).text();
    expect(csv).toContain("'=SUM(A1:A9)");
    expect(csv).not.toMatch(/(^|,)=SUM/m);
    const json = await (await report.GET(jsonReq(`/api/deals/${dealId}/seller-report`, "GET"), params(dealId))).json();
    expect(json.funnel).toEqual((await get(dealId)).funnel);
    const x = await report.GET(jsonReq(`/api/deals/${dealId}/seller-report?format=xlsx`, "GET"), params(dealId));
    expect(x.headers.get("content-type")).toContain("spreadsheetml");
    const bytes = new Uint8Array(await x.arrayBuffer());
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");
    expect((app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'deal.seller_report.export'").get() as { n: number }).n).toBe(2);
  });
});
