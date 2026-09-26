// P5 BANK / FIG: regulatory filings, shareholder votes, suggested-date math and
// the fig_track flag, against a real temp database.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieMock, freshApp, params, jsonReq, cleanup, harness, type App } from "./_harness";
import {
  addDays,
  nextRegulatoryDate,
  orderingError,
  suggestions,
  upcomingRegulatoryDates,
  type Filing,
  type ShareholderVote,
} from "../app/lib/regulatory";

vi.mock("next/headers", () => cookieMock());

// ---- pure date math ----

const filing = (over: Partial<Filing> = {}): Filing => ({
  id: 1,
  deal_id: 1,
  regulator: "FDIC",
  agency_label: null,
  filed_at: null,
  accepted_complete_at: null,
  public_notice_at: null,
  comment_end_at: null,
  approval_at: null,
  doj_concurrence: 0,
  consummation_eligible_at: null,
  status: "preparing",
  notes: null,
  created_at: "",
  updated_at: "",
  ...over,
});
const vote = (over: Partial<ShareholderVote> = {}): ShareholderVote => ({
  id: 1,
  deal_id: 1,
  party: "target",
  record_date: null,
  notice_mailed_at: null,
  meeting_at: null,
  result: "pending",
  votes_for_pct: null,
  notes: null,
  created_at: "",
  updated_at: "",
  ...over,
});

describe("addDays", () => {
  it("crosses month and year ends", () => {
    expect(addDays("2026-01-31", 30)).toBe("2026-03-02");
    expect(addDays("2026-12-15", 30)).toBe("2027-01-14");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("handles leap years", () => {
    expect(addDays("2028-02-29", 30)).toBe("2028-03-30");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2028-01-30", 30)).toBe("2028-02-29");
  });
  it("returns null for empty or impossible dates", () => {
    expect(addDays(null, 30)).toBeNull();
    expect(addDays(undefined, 30)).toBeNull();
    expect(addDays("", 30)).toBeNull();
    expect(addDays("2027-02-29", 30)).toBeNull();
    expect(addDays("11/12/2026", 30)).toBeNull();
  });
  it("is not moved by daylight saving changes", () => {
    expect(addDays("2026-03-01", 30)).toBe("2026-03-31");
    expect(addDays("2026-10-20", 30)).toBe("2026-11-19");
  });
});

describe("suggestions", () => {
  it("comment end = public notice + 30", () => {
    expect(suggestions(filing({ public_notice_at: "2026-10-13" })).comment_end_at).toBe("2026-11-12");
    expect(suggestions(filing({ public_notice_at: "2028-02-29" })).comment_end_at).toBe("2028-03-30");
    expect(suggestions(filing()).comment_end_at).toBeNull();
  });
  it("consummation eligible = approval + 30, or + 15 with DOJ concurrence", () => {
    expect(suggestions(filing({ approval_at: "2026-11-30" })).consummation_eligible_at).toBe("2026-12-30");
    expect(suggestions(filing({ approval_at: "2026-11-30", doj_concurrence: 1 })).consummation_eligible_at).toBe("2026-12-15");
    expect(suggestions({ ...filing({ approval_at: "2026-01-31" }), doj_concurrence: true }).consummation_eligible_at).toBe("2026-02-15");
    expect(suggestions(filing({ approval_at: null, doj_concurrence: 1 })).consummation_eligible_at).toBeNull();
  });
  it("FDIC and OCC approval window is 45 expedited to 60 standard from acceptance", () => {
    for (const regulator of ["FDIC", "OCC"] as const) {
      const s = suggestions(filing({ regulator, accepted_complete_at: "2026-09-01" }));
      expect(s.expected_approval).toMatchObject({ earliest: "2026-10-16", latest: "2026-10-31" });
      expect(s.expected_approval_note).toBeNull();
    }
  });
  it("Fed approval window starts at the 71 day median", () => {
    const s = suggestions(filing({ regulator: "FED", accepted_complete_at: "2026-09-01" }));
    expect(s.expected_approval?.earliest).toBe("2026-11-11");
    expect(s.expected_approval?.latest).toBe("2026-12-12");
  });
  it("State and NCUA have no default window and say so", () => {
    for (const regulator of ["STATE", "NCUA"] as const) {
      const s = suggestions(filing({ regulator, accepted_complete_at: "2026-09-01" }));
      expect(s.expected_approval).toBeNull();
      expect(s.expected_approval_note).toMatch(/No typical approval window/);
    }
  });
  it("no acceptance date means no window, with a note", () => {
    const s = suggestions(filing({ regulator: "FED" }));
    expect(s.expected_approval).toBeNull();
    expect(s.expected_approval_note).toMatch(/accepted as complete/);
  });
});

describe("ordering", () => {
  it("names the later field when the order is impossible", () => {
    expect(orderingError({ filed_at: "2026-09-10", accepted_complete_at: "2026-09-01" })?.field).toBe("accepted_complete_at");
    expect(orderingError({ public_notice_at: "2026-09-10", comment_end_at: "2026-09-09" })?.field).toBe("comment_end_at");
    expect(orderingError({ approval_at: "2026-09-10", consummation_eligible_at: "2026-09-01" })?.field).toBe("consummation_eligible_at");
    expect(orderingError({ filed_at: "2026-09-10", accepted_complete_at: "2026-09-10" })).toBeNull();
    expect(orderingError({ filed_at: "2026-09-10" })).toBeNull();
  });
});

describe("upcoming and next regulatory date", () => {
  const today = "2026-09-25";
  it("lists saved dates in the window, soonest first, skipping past, withdrawn and decided meetings", () => {
    const fs = [
      filing({ id: 1, public_notice_at: "2026-09-01", comment_end_at: "2026-10-01", status: "accepted" }),
      filing({ id: 2, regulator: "STATE", agency_label: "Lone State Banking Dept", filed_at: "2026-09-30", status: "withdrawn" }),
      filing({ id: 3, regulator: "FED", approval_at: "2026-12-01" }),
    ];
    const vs = [vote({ id: 7, record_date: "2026-09-28", meeting_at: "2026-10-20" }), vote({ id: 8, party: "acquirer", meeting_at: "2026-10-02", result: "approved" })];
    const out = upcomingRegulatoryDates(fs, vs, today, 30);
    expect(out.map((r) => r.date)).toEqual(["2026-09-28", "2026-10-01", "2026-10-20"]);
    expect(out[1].label).toBe("FDIC: comment period ends");
    expect(out[0].label).toBe("Target shareholders: record date");
    expect(nextRegulatoryDate(fs, vs, today)?.date).toBe("2026-09-28");
  });
  it("today counts as upcoming; nothing saved means null", () => {
    expect(nextRegulatoryDate([filing({ approval_at: today })], [], today)?.label).toBe("FDIC: approval");
    expect(nextRegulatoryDate([filing()], [vote()], today)).toBeNull();
    expect(nextRegulatoryDate([], [], today)).toBeNull();
  });
  it("next date looks past the 30 day window", () => {
    expect(nextRegulatoryDate([filing({ regulator: "OCC", approval_at: "2027-03-01" })], [], today)?.date).toBe("2027-03-01");
  });
});

// ---- API ----

let app: App;
let route: typeof import("../app/api/deals/[id]/regulatory/route");
let dealRoute: typeof import("../app/api/deals/[id]/route");

beforeEach(async () => {
  vi.resetModules();
  app = await freshApp();
  route = await import("../app/api/deals/[id]/regulatory/route");
  dealRoute = await import("../app/api/deals/[id]/route");
});
afterEach(cleanup);

const url = (id: number, q = "") => `/api/deals/${id}/regulatory${q}`;
const post = (id: number, body: unknown) => route.POST(jsonReq(url(id), "POST", body), params(id));
const patch = (id: number, body: unknown) => route.PATCH(jsonReq(url(id), "PATCH", body), params(id));
const del = (id: number, q: string) => route.DELETE(jsonReq(url(id, q), "DELETE"), params(id));
const get = async (id: number) => (await route.GET(jsonReq(url(id), "GET"), params(id))).json();
const auditCount = (action: string) => (app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = ?").get(action) as { n: number }).n;

async function setup() {
  await app.signIn();
  return app.deal(app.company("Community Bank Co"), "LOI");
}

describe("schema", () => {
  it("regulator, status, party and result are CHECKed; fig_track defaults to 0", async () => {
    const d = await setup();
    const ins = (sql: string) => () => app.db.prepare(sql).run(d);
    expect(ins("INSERT INTO deal_regulatory_filings (deal_id, regulator) VALUES (?, 'SEC')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO deal_regulatory_filings (deal_id, regulator, status) VALUES (?, 'FDIC', 'lost')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO deal_shareholder_votes (deal_id, party) VALUES (?, 'lender')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO deal_shareholder_votes (deal_id, party, result) VALUES (?, 'target', 'maybe')")).toThrow(/CHECK/);
    ins("INSERT INTO deal_shareholder_votes (deal_id, party) VALUES (?, 'target')")();
    expect(ins("INSERT INTO deal_shareholder_votes (deal_id, party) VALUES (?, 'target')")).toThrow(/UNIQUE/);
    expect(app.db.prepare("SELECT fig_track FROM deals WHERE id = ?").get(d)).toEqual({ fig_track: 0 });
  });
  it("deleting a deal cascades its filings and votes", async () => {
    const d = await setup();
    await post(d, { type: "filing", regulator: "FDIC" });
    await post(d, { type: "vote", party: "target" });
    app.db.prepare("DELETE FROM deals WHERE id = ?").run(d);
    expect(app.db.prepare("SELECT COUNT(*) n FROM deal_regulatory_filings").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM deal_shareholder_votes").get()).toEqual({ n: 0 });
  });
});

describe("fig_track on the deal", () => {
  it("PATCH /api/deals/[id] accepts 0/1 (and booleans), audits it, refuses anything else", async () => {
    const d = await setup();
    const p = (body: unknown) => dealRoute.PATCH(jsonReq(`/api/deals/${d}`, "PATCH", body), params(d));
    expect((await p({ fig_track: 1 })).status).toBe(200);
    expect((await get(d)).fig_track).toBe(1);
    expect((await p({ fig_track: false })).status).toBe(200);
    expect((await get(d)).fig_track).toBe(0);
    const bad = await p({ fig_track: 2 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe("fig_track");
    const row = app.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'deal.update' ORDER BY id DESC LIMIT 1").get() as { detail_json: string };
    expect(JSON.parse(row.detail_json)).toEqual({ fig_track: 0 });
  });
});

describe("filings", () => {
  it("adds a filing with validated dates and returns it with suggestions", async () => {
    const d = await setup();
    const res = await post(d, { type: "filing", regulator: "FDIC", filed_at: "2026-08-01", accepted_complete_at: "2026-08-20", public_notice_at: "2026-08-25" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.filings).toHaveLength(1);
    expect(body.filings[0]).toMatchObject({ regulator: "FDIC", status: "preparing", doj_concurrence: 0 });
    expect(body.filings[0].suggestions.comment_end_at).toBe("2026-09-24");
    expect(body.filings[0].suggestions.expected_approval).toMatchObject({ earliest: "2026-10-04", latest: "2026-10-19" });
    // Suggestions are never saved.
    expect(app.db.prepare("SELECT comment_end_at FROM deal_regulatory_filings").get()).toEqual({ comment_end_at: null });
    expect(auditCount("deal.regulatory.filing.add")).toBe(1);
  });
  it("rejects a bad regulator, a bad date and a bad status with the field named", async () => {
    const d = await setup();
    const r1 = await post(d, { type: "filing", regulator: "SEC" });
    expect(r1.status).toBe(400);
    expect((await r1.json()).field).toBe("regulator");
    const r2 = await post(d, { type: "filing", regulator: "OCC", filed_at: "2026-02-30" });
    expect((await r2.json()).field).toBe("filed_at");
    const r3 = await post(d, { type: "filing", regulator: "OCC", approval_at: "Nov 12" });
    expect((await r3.json()).field).toBe("approval_at");
    const r4 = await post(d, { type: "filing", regulator: "OCC", status: "lost" });
    expect((await r4.json()).field).toBe("status");
    expect((await post(d, { type: "memo" })).status).toBe(400);
  });
  it("refuses impossible date order with a 400 naming the field, on add and on edit", async () => {
    const d = await setup();
    const r = await post(d, { type: "filing", regulator: "FDIC", filed_at: "2026-09-10", accepted_complete_at: "2026-09-01" });
    expect(r.status).toBe(400);
    expect((await r.json()).field).toBe("accepted_complete_at");
    const ok = await (await post(d, { type: "filing", regulator: "FDIC", public_notice_at: "2026-09-10", approval_at: "2026-10-01" })).json();
    const id = ok.filings[0].id;
    const e1 = await patch(d, { type: "filing", id, comment_end_at: "2026-09-01" });
    expect((await e1.json()).field).toBe("comment_end_at");
    const e2 = await patch(d, { type: "filing", id, consummation_eligible_at: "2026-09-30" });
    expect(e2.status).toBe(400);
    expect((await e2.json()).field).toBe("consummation_eligible_at");
    // Moving the earlier date past the later one is caught too.
    const e3 = await patch(d, { type: "filing", id, comment_end_at: "2026-10-10" });
    expect(e3.status).toBe(200);
    expect((await patch(d, { type: "filing", id, public_notice_at: "2026-10-11" })).status).toBe(400);
  });
  it("one filing per (regulator, agency label); a second state department needs its own label", async () => {
    const d = await setup();
    expect((await post(d, { type: "filing", regulator: "FDIC" })).status).toBe(201);
    expect((await post(d, { type: "filing", regulator: "FDIC" })).status).toBe(409);
    expect((await post(d, { type: "filing", regulator: "STATE", agency_label: "Lone State Department of Banking" })).status).toBe(201);
    expect((await post(d, { type: "filing", regulator: "STATE", agency_label: "Lone State Department of Banking" })).status).toBe(409);
    expect((await post(d, { type: "filing", regulator: "STATE", agency_label: "Other State Division of Banks" })).status).toBe(201);
  });
  it("PATCH updates only the fields sent and audits old and new values", async () => {
    const d = await setup();
    const { filings } = await (await post(d, { type: "filing", regulator: "OCC", filed_at: "2026-08-01", notes: "Pre-filing call done" })).json();
    const id = filings[0].id;
    const res = await patch(d, { type: "filing", id, status: "filed", doj_concurrence: true });
    expect(res.status).toBe(200);
    const row = (await res.json()).filings[0];
    expect(row).toMatchObject({ status: "filed", doj_concurrence: 1, filed_at: "2026-08-01", notes: "Pre-filing call done" });
    const a = app.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'deal.regulatory.filing.update'").get() as { detail_json: string };
    expect(JSON.parse(a.detail_json).changes).toEqual({ status: { from: "preparing", to: "filed" }, doj_concurrence: { from: 0, to: 1 } });
    // Same values again: no write, no audit row.
    await patch(d, { type: "filing", id, status: "filed" });
    expect(auditCount("deal.regulatory.filing.update")).toBe(1);
    // Clearing a date with null works.
    await patch(d, { type: "filing", id, filed_at: null });
    expect((await get(d)).filings[0].filed_at).toBeNull();
  });
  it("a filing from another deal is a 404, not an edit", async () => {
    const d1 = await setup();
    const d2 = app.deal(app.company("Other Bank"), "LOI");
    const { filings } = await (await post(d1, { type: "filing", regulator: "FED" })).json();
    expect((await patch(d2, { type: "filing", id: filings[0].id, status: "filed" })).status).toBe(404);
    expect((await del(d2, `?type=filing&id=${filings[0].id}`)).status).toBe(404);
    expect((await post(99999, { type: "filing", regulator: "FED" })).status).toBe(404);
  });
  it("DELETE removes the row and audits the full old row", async () => {
    const d = await setup();
    const { filings } = await (await post(d, { type: "filing", regulator: "FED", agency_label: "Holding company", accepted_complete_at: "2026-08-15" })).json();
    const res = await del(d, `?type=filing&id=${filings[0].id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).filings).toEqual([]);
    const a = app.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'deal.regulatory.filing.delete'").get() as { detail_json: string };
    expect(JSON.parse(a.detail_json).old).toMatchObject({ regulator: "FED", agency_label: "Holding company", accepted_complete_at: "2026-08-15", deal_id: d });
    expect((await del(d, "?type=filing&id=abc")).status).toBe(400);
    expect((await del(d, "?type=other&id=1")).status).toBe(400);
  });
});

describe("shareholder votes", () => {
  it("tracks record date, notice mailed, meeting and result, one per party", async () => {
    const d = await setup();
    const res = await post(d, { type: "vote", party: "target", record_date: "2026-10-01", notice_mailed_at: "2026-10-05", meeting_at: "2026-11-10" });
    expect(res.status).toBe(201);
    const v = (await res.json()).votes[0];
    expect(v).toMatchObject({ party: "target", record_date: "2026-10-01", notice_mailed_at: "2026-10-05", meeting_at: "2026-11-10", result: "pending" });
    expect((await post(d, { type: "vote", party: "target" })).status).toBe(409);
    const upd = await patch(d, { type: "vote", id: v.id, result: "approved", votes_for_pct: 92.4 });
    expect((await upd.json()).votes[0]).toMatchObject({ result: "approved", votes_for_pct: 92.4 });
    expect((await patch(d, { type: "vote", id: v.id, votes_for_pct: 140 })).status).toBe(400);
    expect((await patch(d, { type: "vote", id: v.id, result: "maybe" })).status).toBe(400);
    const badDate = await patch(d, { type: "vote", id: v.id, meeting_at: "2026-13-01" });
    expect((await badDate.json()).field).toBe("meeting_at");
    expect((await post(d, { type: "vote", party: "lender" })).status).toBe(400);
    expect((await del(d, `?type=vote&id=${v.id}`)).status).toBe(200);
    expect(auditCount("deal.regulatory.vote.add")).toBe(1);
    expect(auditCount("deal.regulatory.vote.update")).toBe(1);
    expect(auditCount("deal.regulatory.vote.delete")).toBe(1);
  });
});

describe("auth", () => {
  it("401 when signed out on every method", async () => {
    const d = await setup();
    harness.token = undefined;
    expect((await route.GET(jsonReq(url(d), "GET"), params(d))).status).toBe(401);
    expect((await post(d, { type: "filing", regulator: "FDIC" })).status).toBe(401);
    expect((await patch(d, { type: "filing", id: 1 })).status).toBe(401);
    expect((await del(d, "?type=filing&id=1")).status).toBe(401);
  });
});
