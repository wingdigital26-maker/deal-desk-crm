// FOLLOWUPS: buyer next steps (API, revisions, Today query, seller report
// stays clean), the morning brief rules, and the voice-note text helpers.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieMock, freshApp, params, jsonReq, cleanup, type App } from "./_harness";
import { addCalendarDays, followUpAttention, followUpTitle, isFollowUpDue, pickDueItems } from "../app/lib/followups";
import { joinDictation, speechRecognitionCtor, transcriptFrom } from "../app/components/crm/voiceText";
import type { BriefInput } from "../app/lib/brief";
import type { Filing } from "../app/lib/regulatory";

vi.mock("next/headers", () => cookieMock());

const TODAY = "2026-09-28";
const localToday = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};

describe("follow-up helpers (pure)", () => {
  it("adds calendar days across a month end", () => {
    expect(addCalendarDays("2026-09-28", 3)).toBe("2026-10-01");
    expect(addCalendarDays("2026-12-29", 7)).toBe("2027-01-05");
  });
  it("labels overdue and due today with the house attention words, and nothing else", () => {
    expect(followUpAttention({ stage: "cim_sent", next_step_due: "2026-09-25" }, TODAY).label).toEqual({ kind: "overdue", text: "Overdue 3 days", tone: "stop" });
    expect(followUpAttention({ stage: "cim_sent", next_step_due: TODAY }, TODAY).label?.kind).toBe("due-today");
    expect(followUpAttention({ stage: "cim_sent", next_step_due: "2026-10-02" }, TODAY).label).toBeNull();
    expect(followUpAttention({ stage: "cim_sent", next_step_due: null }, TODAY).label).toBeNull();
    // A declined or closed buyer is out of the process: never flagged.
    expect(followUpAttention({ stage: "declined", next_step_due: "2026-09-01" }, TODAY).label).toBeNull();
  });
  it("isFollowUpDue: today or earlier, buyer still in play", () => {
    expect(isFollowUpDue({ stage: "ioi", next_step_due: TODAY }, TODAY)).toBe(true);
    expect(isFollowUpDue({ stage: "ioi", next_step_due: "2026-09-20" }, TODAY)).toBe(true);
    expect(isFollowUpDue({ stage: "ioi", next_step_due: "2026-09-29" }, TODAY)).toBe(false);
    expect(isFollowUpDue({ stage: "closed", next_step_due: "2026-09-20" }, TODAY)).toBe(false);
    expect(isFollowUpDue({ stage: "ioi", next_step_due: null }, TODAY)).toBe(false);
  });
  it("titles a follow-up with the deal title, falling back to the company", () => {
    expect(followUpTitle("Red Oak Capital", "Project Falcon", "Falcon Co")).toBe("Buyer: Red Oak Capital on Project Falcon");
    expect(followUpTitle("Red Oak Capital", "  ", "Falcon Co")).toBe("Buyer: Red Oak Capital on Falcon Co");
    expect(followUpTitle("Red Oak Capital", null, null)).toBe("Buyer: Red Oak Capital");
  });
});

describe("Today's short list", () => {
  it("keeps up to N buyer follow-ups even under a pile of older tasks, in date order", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ kind: "task", due: `2026-09-${String(i + 1).padStart(2, "0")}`, id: i }));
    const buyers = [
      { kind: "buyer", due: "2026-09-27", id: 100 },
      { kind: "buyer", due: "2026-09-28", id: 101 },
    ];
    const shown = pickDueItems([...buyers, ...tasks], 7, 3);
    expect(shown).toHaveLength(7);
    expect(shown.filter((x) => x.kind === "buyer").map((x) => x.id)).toEqual([100, 101]);
    expect(shown.map((x) => x.due)).toEqual([...shown.map((x) => x.due)].sort());
    expect(pickDueItems(tasks.slice(0, 3), 7, 3)).toHaveLength(3);
  });
});

describe("voice note text (pure)", () => {
  it("finds the standard or webkit constructor, or null", () => {
    class A {}
    expect(speechRecognitionCtor({ SpeechRecognition: A })).toBe(A);
    expect(speechRecognitionCtor({ webkitSpeechRecognition: A })).toBe(A);
    expect(speechRecognitionCtor({})).toBeNull();
    expect(speechRecognitionCtor(undefined)).toBeNull();
  });
  it("joins final and interim results into one tidy string", () => {
    expect(transcriptFrom([[{ transcript: "Called Dana" }], [{ transcript: " about the  NDA " }]])).toBe("Called Dana about the NDA");
    expect(transcriptFrom([])).toBe("");
  });
  it("appends dictation after what was typed, with one space", () => {
    expect(joinDictation("", "hello")).toBe("hello");
    expect(joinDictation("Met CFO.", "Wants a call")).toBe("Met CFO. Wants a call");
    expect(joinDictation("Met CFO. ", "Wants a call")).toBe("Met CFO. Wants a call");
    expect(joinDictation("Typed", "  ")).toBe("Typed");
  });
});

describe("morning brief rules (pure)", () => {
  let buildBrief: typeof import("../app/lib/brief").buildBrief;
  let briefCountsText: typeof import("../app/lib/brief").briefCountsText;
  beforeEach(async () => {
    ({ buildBrief, briefCountsText } = await import("../app/lib/brief"));
  });

  const empty = (): BriefInput => ({ tasks: [], deals: [], buyers: [], bids: [], figDeals: [], people: [], closedStages: ["Closed", "Passed"] });
  const buyer = (over: Partial<BriefInput["buyers"][number]>) => ({
    id: 1,
    deal_id: 10,
    deal_title: "Project Falcon",
    company_name: "Falcon Co",
    buyer_name: "Red Oak Capital",
    stage: "cim_sent",
    next_step: null,
    next_step_due: null,
    last_move_at: "2026-09-27 10:00:00",
    ...over,
  });
  const deal = (over: Partial<BriefInput["deals"][number]>) => ({
    id: 10,
    title: "Project Falcon",
    company_name: "Falcon Co",
    stage: "In Market",
    next_step: null,
    next_step_due: null,
    last_interaction_at: "2026-09-27 10:00:00",
    last_activity_at: "2026-09-27 10:00:00",
    created_at: "2026-01-01 10:00:00",
    ...over,
  });

  it("an empty desk has no sections and no counts line", () => {
    const b = buildBrief(empty(), TODAY);
    expect(b.sections).toEqual([]);
    expect(briefCountsText(b.counts)).toBeNull();
  });

  it("overdue and due today mix deal steps, tasks and buyer follow-ups; future items stay out", () => {
    const input = empty();
    input.tasks = [
      { id: 1, title: "Send engagement letter", due: "2026-09-26", deal_id: 10, deal_title: "Project Falcon", company_name: "Falcon Co" },
      { id: 2, title: "Call Dana", due: TODAY, deal_id: null, deal_title: null, company_name: null },
    ];
    input.deals = [deal({ next_step: "Send CIM", next_step_due: "2026-09-27" }), deal({ id: 11, company_name: "Later Co", next_step: "Later", next_step_due: "2026-10-05" })];
    input.buyers = [
      buyer({ id: 1, next_step: "Chase NDA markup", next_step_due: "2026-09-25" }),
      buyer({ id: 2, buyer_name: "Blue Fir Partners", next_step: "Confirm mgmt meeting", next_step_due: TODAY }),
      buyer({ id: 3, buyer_name: "Future Co", next_step_due: "2026-10-01" }),
    ];
    const b = buildBrief(input, TODAY);
    const overdue = b.sections.find((s) => s.id === "overdue")!;
    expect(overdue.items.map((i) => i.text)).toEqual(["Buyer: Red Oak Capital on Project Falcon", "Send engagement letter", "Send CIM"]);
    expect(overdue.items[0]).toMatchObject({ detail: "Chase NDA markup", meta: "Overdue 3 days", tone: "stop", href: "/pipeline/10#buyers" });
    expect(overdue.items[2].meta).toBe("Overdue 1 day");
    const today = b.sections.find((s) => s.id === "today")!;
    expect(today.items.map((i) => i.text)).toEqual(["Buyer: Blue Fir Partners on Project Falcon", "Call Dana"]);
    expect(b.counts.overdue).toBe(3);
    expect(b.counts.today).toBe(2);
  });

  it("buyers waiting: a follow-up due, or 14+ days without a move at NDA signed or later", () => {
    const input = empty();
    input.buyers = [
      buyer({ id: 1, buyer_name: "Stale CIM", stage: "cim_sent", last_move_at: "2026-09-10 09:00:00" }), // 18 days
      buyer({ id: 2, buyer_name: "Early Teaser", stage: "teaser_sent", last_move_at: "2026-08-01 09:00:00" }), // too early a stage
      buyer({ id: 3, buyer_name: "Fresh NDA", stage: "nda_signed", last_move_at: "2026-09-23 09:00:00" }), // 5 days
      buyer({ id: 4, buyer_name: "Exactly 14", stage: "nda_signed", last_move_at: "2026-09-14 23:00:00" }),
      buyer({ id: 5, buyer_name: "Due Teaser", stage: "teaser_sent", next_step_due: "2026-09-27", last_move_at: "2026-09-27 09:00:00" }),
      buyer({ id: 6, buyer_name: "Declined", stage: "declined", last_move_at: "2026-08-01 09:00:00", next_step_due: "2026-09-01" }),
    ];
    const w = buildBrief(input, TODAY).sections.find((s) => s.id === "waiting")!;
    expect(w.items.map((i) => i.text.split(" on ")[0])).toEqual(["Due Teaser", "Stale CIM", "Exactly 14"]);
    expect(w.items[0]).toMatchObject({ detail: "Teaser sent · follow-up overdue since Sep 27", meta: "Overdue 1 day", tone: "stop" });
    expect(w.items[1]).toMatchObject({ detail: "CIM sent · no move in 18 days", meta: "Idle 18 days", tone: "warn" });
  });

  it("deals going quiet reuse attention.ts (21+ days); closed deals never show", () => {
    const input = empty();
    input.deals = [
      deal({ id: 1, company_name: "Quiet Co", last_interaction_at: "2026-09-01 10:00:00" }),
      deal({ id: 2, company_name: "Busy Co" }),
      deal({ id: 3, company_name: "Closed Co", stage: "Closed", last_interaction_at: "2026-01-01 10:00:00" }),
    ];
    const q = buildBrief(input, TODAY).sections.find((s) => s.id === "quiet")!;
    expect(q.items.map((i) => [i.text, i.meta])).toEqual([["Quiet Co", "Quiet 27 days"]]);
  });

  it("bids: the latest IOI and LOI per buyer in the last 7 days, older ones dropped", () => {
    const input = empty();
    const base = { deal_id: 10, deal_title: "Project Falcon", company_name: "Falcon Co", ioi_low: 40_000_000, ioi_high: 45_000_000, loi_value: 44_000_000 };
    input.bids = [
      { ...base, deal_buyer_id: 1, buyer_name: "Red Oak Capital", field: "ioi_low", created_at: "2026-09-24 10:00:00" },
      { ...base, deal_buyer_id: 1, buyer_name: "Red Oak Capital", field: "ioi_high", created_at: "2026-09-24 10:00:01" },
      { ...base, deal_buyer_id: 1, buyer_name: "Red Oak Capital", field: "loi_value", created_at: "2026-09-27 10:00:00" },
      { ...base, deal_buyer_id: 2, buyer_name: "Old Bid LP", field: "ioi_low", created_at: "2026-09-10 10:00:00" },
    ];
    const bids = buildBrief(input, TODAY).sections.find((s) => s.id === "bids")!;
    expect(bids.items.map((i) => i.detail)).toEqual(["LOI $44M", "IOI $40M to $45M"]);
    expect(bids.items[0].meta).toBe("Sep 27");
  });

  it("regulatory dates only inside 14 days; people due come through", () => {
    const input = empty();
    const filing = {
      id: 1, deal_id: 5, regulator: "FDIC", agency_label: null, filed_at: "2026-09-01", accepted_complete_at: null, public_notice_at: "2026-10-05",
      comment_end_at: "2026-10-20", approval_at: null, doj_concurrence: 0, consummation_eligible_at: null, status: "filed", notes: null, created_at: "", updated_at: "",
    } as Filing;
    input.figDeals = [{ id: 5, company_name: "First Prairie Bank", filings: [filing], votes: [] }];
    input.people = [{ id: 7, first_name: "Dana", last_name: "Cole", company_id: null, company_name: "Cole CPA", touch_every_days: 30, last_touch_at: null, days_since: null }];
    const b = buildBrief(input, TODAY);
    const reg = b.sections.find((s) => s.id === "regulatory")!;
    expect(reg.items).toHaveLength(1);
    expect(reg.items[0]).toMatchObject({ text: "First Prairie Bank", meta: "Oct 5" });
    expect(b.sections.find((s) => s.id === "people")!.items[0]).toMatchObject({ text: "Dana Cole", meta: "Never touched" });
    expect(briefCountsText(b.counts)).toBe("1 regulatory date, 1 person due a touch");
  });
});

describe("buyer follow-ups through the API", () => {
  let app: App;
  let list: typeof import("../app/api/deal-buyers/route");
  let one: typeof import("../app/api/deal-buyers/[id]/route");

  beforeEach(async () => {
    vi.resetModules();
    app = await freshApp();
    list = await import("../app/api/deal-buyers/route");
    one = await import("../app/api/deal-buyers/[id]/route");
  });
  afterEach(cleanup);

  async function setup(n = 1, stage = "In Market") {
    await app.signIn();
    const seller = app.company("Falcon Co");
    const dealId = app.deal(seller, stage, "Project Falcon");
    const buyers = Array.from({ length: n }, (_, i) => app.company(`Buyer ${i}`));
    const res = await list.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: dealId, buyers: buyers.map((b) => ({ buyer_company_id: b })) }));
    return { dealId, rows: (await res.json()).created as number[] };
  }
  const patch = (id: number, body: unknown) => one.PATCH(jsonReq(`/api/deal-buyers/${id}`, "PATCH", body), params(id));

  it("adds the two columns", () => {
    const cols = (app.db.prepare("PRAGMA table_info(deal_buyers)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["next_step", "next_step_due"]));
  });

  it("saves a next step and date, logs old and new values, and audits", async () => {
    const { rows } = await setup();
    const res = await patch(rows[0], { next_step: "  Chase NDA markup ", next_step_due: "2026-10-01" });
    expect(res.status).toBe(200);
    const item = (await res.json()).item;
    expect(item.next_step).toBe("Chase NDA markup");
    expect(item.next_step_due).toBe("2026-10-01");
    await patch(rows[0], { next_step_due: "2026-10-05" });
    const revs = app.db.prepare("SELECT field, old_value, new_value FROM deal_buyer_revisions WHERE deal_buyer_id = ? ORDER BY id").all(rows[0]);
    expect(revs).toEqual([
      { field: "next_step", old_value: null, new_value: "Chase NDA markup" },
      { field: "next_step_due", old_value: null, new_value: "2026-10-01" },
      { field: "next_step_due", old_value: "2026-10-01", new_value: "2026-10-05" },
    ]);
    const audits = app.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'deal_buyer.update' AND entity_id = ?").all(rows[0]) as { detail_json: string }[];
    expect(audits).toHaveLength(2);
    expect(audits[0].detail_json).toContain("next_step_due");
  });

  it("clears with nulls; an unchanged value writes no revision", async () => {
    const { rows } = await setup();
    await patch(rows[0], { next_step: "Call", next_step_due: "2026-10-01" });
    const again = await patch(rows[0], { next_step: "Call" });
    expect(again.status).toBe(200);
    const res = await patch(rows[0], { next_step: null, next_step_due: "" });
    const item = (await res.json()).item;
    expect(item.next_step).toBeNull();
    expect(item.next_step_due).toBeNull();
    expect((app.db.prepare("SELECT COUNT(*) n FROM deal_buyer_revisions WHERE deal_buyer_id = ?").get(rows[0]) as { n: number }).n).toBe(4);
  });

  it("rejects a bad date or an overlong step with a 400 naming the field", async () => {
    const { rows } = await setup();
    for (const [body, field] of [
      [{ next_step_due: "10/01/2026" }, "next_step_due"],
      [{ next_step_due: "2026-02-30" }, "next_step_due"],
      [{ next_step: "x".repeat(301) }, "next_step"],
      [{ next_step: 42 }, "next_step"],
    ] as const) {
      const res = await patch(rows[0], body);
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe(field);
    }
  });

  it("401 when signed out", async () => {
    const { rows } = await setup();
    app.signOut();
    expect((await patch(rows[0], { next_step: "x" })).status).toBe(401);
  });

  it("buyerFollowUpsDue: due today or overdue, buyers and deals still in play only", async () => {
    const { dealId, rows } = await setup(5);
    const today = localToday();
    const { addCalendarDays: add } = await import("../app/lib/followups");
    await patch(rows[0], { next_step: "Overdue one", next_step_due: add(today, -2) });
    await patch(rows[1], { next_step: "Today one", next_step_due: today });
    await patch(rows[2], { next_step: "Future", next_step_due: add(today, 3) });
    await patch(rows[3], { next_step: "Declined", next_step_due: add(today, -1) });
    await patch(rows[3], { stage: "declined", decline_reason: "Valuation gap" });
    await patch(rows[4], { next_step: "Removed", next_step_due: add(today, -1) });
    await one.DELETE(jsonReq(`/api/deal-buyers/${rows[4]}`, "DELETE"), params(rows[4]));
    const { buyerFollowUpsDue } = await import("../app/lib/buyers");
    const due = buyerFollowUpsDue(today, ["Closed", "Passed"]);
    expect(due.map((d) => d.next_step)).toEqual(["Overdue one", "Today one"]);
    expect(due[0]).toMatchObject({ deal_id: dealId, deal_title: "Project Falcon", company_name: "Falcon Co", buyer_name: "Buyer 0" });
    app.db.prepare("UPDATE deals SET stage = 'Passed' WHERE id = ?").run(dealId);
    expect(buyerFollowUpsDue(today, ["Closed", "Passed"])).toEqual([]);
  });

  it("the seller report (JSON, CSV and XLSX) never carries a next step", async () => {
    const report = await import("../app/api/deals/[id]/seller-report/route");
    const { dealId, rows } = await setup();
    await patch(rows[0], { next_step: "SECRET-INTERNAL-STEP", next_step_due: "2026-10-01" });
    const json = await (await report.GET(jsonReq(`/api/deals/${dealId}/seller-report`, "GET"), params(dealId))).text();
    expect(json).not.toContain("SECRET-INTERNAL-STEP");
    expect(json).not.toContain("2026-10-01");
    const csv = await (await report.GET(jsonReq(`/api/deals/${dealId}/seller-report?format=csv`, "GET"), params(dealId))).text();
    expect(csv).not.toContain("SECRET-INTERNAL-STEP");
    expect(csv.toLowerCase()).not.toContain("next step");
    const x = await report.GET(jsonReq(`/api/deals/${dealId}/seller-report?format=xlsx`, "GET"), params(dealId));
    const bytes = Buffer.from(await x.arrayBuffer()).toString("latin1");
    expect(bytes).not.toContain("SECRET-INTERNAL-STEP");
  });

  it("loadBrief reads the database: a buyer follow-up and a fresh IOI land in their sections", async () => {
    const { rows } = await setup(2);
    const today = localToday();
    const { addCalendarDays: add } = await import("../app/lib/followups");
    await patch(rows[0], { next_step: "Chase NDA markup", next_step_due: add(today, -1) });
    await patch(rows[1], { stage: "ioi" });
    await patch(rows[1], { ioi_low: 40_000_000, ioi_high: 45_000_000 });
    const { loadBrief } = await import("../app/lib/brief");
    const b = loadBrief(today);
    expect(b.sections.find((s) => s.id === "overdue")!.items[0].text).toBe("Buyer: Buyer 0 on Project Falcon");
    expect(b.sections.find((s) => s.id === "waiting")!.items[0].text).toBe("Buyer 0 on Project Falcon");
    expect(b.sections.find((s) => s.id === "bids")!.items[0]).toMatchObject({ text: "Buyer 1 on Project Falcon", detail: "IOI $40M to $45M" });
  });
});
