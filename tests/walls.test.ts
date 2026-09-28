// WALLS: need-to-know deal access (MNPI, Exchange Act 15(g)), deal code names,
// the buyer conflict check and the People admin deal-access data.
// The core test walks EVERY deal-scoped route: a member who is not on the deal
// gets 404 (or an empty list), a teammate gets the normal 2xx.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieMock, freshApp, params, jsonReq, cleanup, harness, type App } from "./_harness";

vi.mock("next/headers", () => cookieMock());

let app: App;
type Mod = Record<string, (req: Request, ctx?: unknown) => Promise<Response>>;
const r: Record<string, Mod> = {};

const ROUTES = {
  deals: "../app/api/deals/route",
  deal: "../app/api/deals/[id]/route",
  team: "../app/api/deals/[id]/team/route",
  regulatory: "../app/api/deals/[id]/regulatory/route",
  sellerReport: "../app/api/deals/[id]/seller-report/route",
  buyers: "../app/api/deal-buyers/route",
  buyer: "../app/api/deal-buyers/[id]/route",
  bulk: "../app/api/deal-buyers/bulk-stage/route",
  candidates: "../app/api/deal-buyers/candidates/route",
  docs: "../app/api/documents/route",
  doc: "../app/api/documents/[id]/route",
  download: "../app/api/documents/[id]/download/route",
  activities: "../app/api/activities/route",
  tasks: "../app/api/tasks/route",
  task: "../app/api/tasks/[id]/route",
  exportApi: "../app/api/export/[entity]/route",
  search: "../app/api/search/route",
  buyerHistory: "../app/api/companies/[id]/buyer-history/route",
} as const;

beforeEach(async () => {
  vi.resetModules();
  app = await freshApp();
  for (const [k, path] of Object.entries(ROUTES)) r[k] = (await import(/* @vite-ignore */ path)) as unknown as Mod;
});
afterEach(cleanup);

/** Signs in as an existing user (the harness signIn always creates a new one). */
async function as(id: number) {
  const session = await import("../app/lib/session");
  const u = app.db.prepare("SELECT email, name, role FROM users WHERE id = ?").get(id) as { email: string; name: string; role: "owner" | "principal" | "member" };
  harness.token = (await session.signSession({ id, ...u })) ?? undefined;
}

function upload(fields: Record<string, string | number>) {
  const form = new FormData();
  form.set("file", new File(["%PDF-1.4 walls test"], "Seller Co teaser.pdf", { type: "application/pdf" }));
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  return r.docs.POST(new Request("http://test/api/documents", { method: "POST", body: form }));
}

/** One mandate with a buyer log, a document, a task, a note and a regulatory filing. */
async function world() {
  const owner = await app.signIn("owner", "Desk Owner");
  const outsider = await app.signIn("member", "Outside Member");
  const teammate = await app.signIn("member", "Team Member");
  const spare = await app.signIn("member", "Spare Member");
  const seller = app.company("Seller Co");
  const dealId = app.deal(seller, "In Market", "Sale of Seller Co");
  app.insert("deal_team", { deal_id: dealId, user_id: teammate, role: "execution" });
  const [b1, b2, b3] = [app.company("Buyer One"), app.company("Buyer Two"), app.company("Buyer Three")];
  const buyerRows = [b1, b2].map((c) => app.insert("deal_buyers", { deal_id: dealId, buyer_company_id: c, stage: "teaser_sent" }));
  await as(owner);
  const up = await upload({ deal_id: dealId, kind: "teaser" });
  const docId = (await up.json()).document.id as number;
  const taskId = app.insert("tasks", { title: "Send CIM", due: "2026-01-01", deal_id: dealId });
  app.insert("activities", { kind: "note", body: "Walls note", company_id: seller, deal_id: dealId });
  const filingId = app.insert("deal_regulatory_filings", { deal_id: dealId, regulator: "FDIC", status: "preparing" });
  const referrer = app.contact({ first_name: "Rae" });
  app.db.prepare("UPDATE deals SET referral_contact_id = ? WHERE id = ?").run(referrer, dealId);
  return { owner, outsider, teammate, spare, seller, dealId, b1, b2, b3, buyerRows, docId, taskId, filingId, referrer };
}
type World = Awaited<ReturnType<typeof world>>;

/** Every route that reads or writes one deal (or something hanging off it). */
function scopedCases(w: World): { name: string; run: () => Promise<Response>; hiddenStatus?: number }[] {
  const d = w.dealId;
  return [
    { name: "GET /api/deals/:id", run: () => r.deal.GET(jsonReq(`/api/deals/${d}`, "GET"), params(d)) },
    { name: "PATCH /api/deals/:id", run: () => r.deal.PATCH(jsonReq(`/api/deals/${d}`, "PATCH", { next_step: "Call" }), params(d)) },
    { name: "GET /api/deals/:id/team", run: () => r.team.GET(jsonReq(`/api/deals/${d}/team`, "GET"), params(d)) },
    { name: "POST /api/deals/:id/team", run: () => r.team.POST(jsonReq(`/api/deals/${d}/team`, "POST", { user_id: w.spare }), params(d)) },
    { name: "PATCH /api/deals/:id/team", run: () => r.team.PATCH(jsonReq(`/api/deals/${d}/team`, "PATCH", { user_id: w.spare, role: "analyst" }), params(d)) },
    { name: "DELETE /api/deals/:id/team", run: () => r.team.DELETE(jsonReq(`/api/deals/${d}/team?user_id=${w.spare}`, "DELETE"), params(d)) },
    { name: "GET /api/deals/:id/regulatory", run: () => r.regulatory.GET(jsonReq(`/api/deals/${d}/regulatory`, "GET"), params(d)) },
    { name: "POST /api/deals/:id/regulatory", run: () => r.regulatory.POST(jsonReq(`/api/deals/${d}/regulatory`, "POST", { type: "vote", party: "target" }), params(d)) },
    { name: "PATCH /api/deals/:id/regulatory", run: () => r.regulatory.PATCH(jsonReq(`/api/deals/${d}/regulatory`, "PATCH", { type: "filing", id: w.filingId, notes: "x" }), params(d)) },
    {
      // Deletes the vote the POST case just added (a missing id for the outsider, who never got that far).
      name: "DELETE /api/deals/:id/regulatory",
      run: () => {
        const v = app.db.prepare("SELECT id FROM deal_shareholder_votes WHERE deal_id = ?").get(d) as { id: number } | undefined;
        return r.regulatory.DELETE(jsonReq(`/api/deals/${d}/regulatory?type=vote&id=${v?.id ?? 999999}`, "DELETE"), params(d));
      },
    },
    { name: "GET /api/deals/:id/seller-report", run: () => r.sellerReport.GET(jsonReq(`/api/deals/${d}/seller-report`, "GET"), params(d)) },
    { name: "GET /api/deals/:id/seller-report?format=csv", run: () => r.sellerReport.GET(jsonReq(`/api/deals/${d}/seller-report?format=csv`, "GET"), params(d)) },
    { name: "GET /api/deal-buyers?deal_id", run: () => r.buyers.GET(jsonReq(`/api/deal-buyers?deal_id=${d}`, "GET")) },
    { name: "POST /api/deal-buyers", run: () => r.buyers.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: d, buyers: [{ buyer_company_id: w.b3 }] })) },
    { name: "PATCH /api/deal-buyers/:id", run: () => r.buyer.PATCH(jsonReq(`/api/deal-buyers/${w.buyerRows[0]}`, "PATCH", { stage: "nda_sent" }), params(w.buyerRows[0])) },
    { name: "POST /api/deal-buyers/bulk-stage", run: () => r.bulk.POST(jsonReq("/api/deal-buyers/bulk-stage", "POST", { ids: w.buyerRows, stage: "nda_signed" })) },
    { name: "DELETE /api/deal-buyers/:id", run: () => r.buyer.DELETE(jsonReq(`/api/deal-buyers/${w.buyerRows[1]}`, "DELETE"), params(w.buyerRows[1])) },
    { name: "GET /api/deal-buyers/candidates", run: () => r.candidates.GET(jsonReq(`/api/deal-buyers/candidates?deal_id=${d}`, "GET")) },
    { name: "GET /api/documents?deal_id", run: () => r.docs.GET(jsonReq(`/api/documents?deal_id=${d}`, "GET")) },
    { name: "POST /api/documents", run: () => upload({ deal_id: d, kind: "cim" }) },
    { name: "GET /api/documents/:id", run: () => r.doc.GET(jsonReq(`/api/documents/${w.docId}`, "GET"), params(w.docId)) },
    { name: "PATCH /api/documents/:id", run: () => r.doc.PATCH(jsonReq(`/api/documents/${w.docId}`, "PATCH", { note: "checked" }), params(w.docId)) },
    { name: "GET /api/documents/:id/download", run: () => r.download.GET(jsonReq(`/api/documents/${w.docId}/download`, "GET"), params(w.docId)) },
    { name: "GET /api/activities?deal_id", run: () => r.activities.GET(jsonReq(`/api/activities?deal_id=${d}`, "GET")) },
    { name: "POST /api/activities with deal_id", run: () => r.activities.POST(jsonReq("/api/activities", "POST", { kind: "note", body: "hi", deal_id: d })) },
    { name: "POST /api/tasks with deal_id", run: () => r.tasks.POST(jsonReq("/api/tasks", "POST", { title: "Chase NDA", deal_id: d })), hiddenStatus: 400 },
    { name: "GET /api/tasks/:id", run: () => r.task.GET(jsonReq(`/api/tasks/${w.taskId}`, "GET"), params(w.taskId)) },
    { name: "PATCH /api/tasks/:id", run: () => r.task.PATCH(jsonReq(`/api/tasks/${w.taskId}`, "PATCH", { done: true }), params(w.taskId)) },
  ];
}

describe("need-to-know access on every deal-scoped route", () => {
  it("a member not on the deal gets 404 everywhere and nothing changes", async () => {
    const w = await world();
    await as(w.outsider);
    const auditBefore = (app.db.prepare("SELECT COUNT(*) n FROM audit_log").get() as { n: number }).n;
    for (const c of scopedCases(w)) {
      const res = await c.run();
      expect({ route: c.name, status: res.status }).toEqual({ route: c.name, status: c.hiddenStatus ?? 404 });
    }
    // Nothing was written behind the wall.
    expect((app.db.prepare("SELECT COUNT(*) n FROM audit_log").get() as { n: number }).n).toBe(auditBefore);
    expect(app.db.prepare("SELECT stage FROM deal_buyers WHERE id = ?").get(w.buyerRows[0])).toMatchObject({ stage: "teaser_sent" });
    expect((app.db.prepare("SELECT COUNT(*) n FROM deal_team WHERE user_id = ?").get(w.spare) as { n: number }).n).toBe(0);
  });

  it("404 bodies are the same for a hidden deal and a missing one (existence does not leak)", async () => {
    const w = await world();
    await as(w.outsider);
    const hidden = await (await r.deal.GET(jsonReq(`/api/deals/${w.dealId}`, "GET"), params(w.dealId))).json();
    const missing = await (await r.deal.GET(jsonReq("/api/deals/999999", "GET"), params(999999))).json();
    expect(hidden).toEqual(missing);
    const t1 = await (await r.tasks.POST(jsonReq("/api/tasks", "POST", { title: "x", deal_id: w.dealId }))).json();
    const t2 = await (await r.tasks.POST(jsonReq("/api/tasks", "POST", { title: "x", deal_id: 999999 }))).json();
    expect(t1).toEqual(t2);
  });

  it("a teammate gets 2xx on every one of the same routes", async () => {
    const w = await world();
    await as(w.teammate);
    for (const c of scopedCases(w)) {
      const res = await c.run();
      expect({ route: c.name, ok: res.ok, status: res.status }).toMatchObject({ route: c.name, ok: true });
    }
  });

  it("the deal owner of record sees the deal without a team seat", async () => {
    const w = await world();
    app.db.prepare("UPDATE deals SET owner_user_id = ? WHERE id = ?").run(w.outsider, w.dealId);
    await as(w.outsider);
    expect((await r.deal.GET(jsonReq(`/api/deals/${w.dealId}`, "GET"), params(w.dealId))).status).toBe(200);
  });

  it("owners see every deal, and opening one they are not on is recorded once per hour", async () => {
    const w = await world();
    await as(w.owner);
    expect((await r.deal.GET(jsonReq(`/api/deals/${w.dealId}`, "GET"), params(w.dealId))).status).toBe(200);
    const access = await import("../app/lib/dealAccess");
    const owner = { id: w.owner, role: "owner" };
    access.recordOutsideTeamView(owner, w.dealId, "deal_page");
    access.recordOutsideTeamView(owner, w.dealId, "deal_page");
    const n = () => (app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'deal.view.outside_team'").get() as { n: number }).n;
    expect(n()).toBe(1);
    // On the team: no crossing to record.
    const other = app.deal(app.company());
    app.insert("deal_team", { deal_id: other, user_id: w.owner, role: "lead" });
    access.recordOutsideTeamView(owner, other, "deal_page");
    expect(n()).toBe(1);
  });
});

describe("lists and derived data only show visible deals", () => {
  const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

  it("pipeline, search, tasks, timelines, exports, buyer history and referral credit", async () => {
    const w = await world();
    for (const [user, sees] of [
      [w.outsider, false],
      [w.teammate, true],
      [w.owner, true],
    ] as const) {
      await as(user);
      const deals = (await (await r.deals.GET(jsonReq("/api/deals", "GET"))).json()).items;
      expect(ids(deals).includes(w.dealId)).toBe(sees);
      const q = (await (await r.deals.GET(jsonReq("/api/deals?q=Seller", "GET"))).json()).items;
      expect(ids(q).includes(w.dealId)).toBe(sees);
      const s = await (await r.search.GET(jsonReq("/api/search?q=Seller", "GET"))).json();
      expect(ids(s.deals).includes(w.dealId)).toBe(sees);
      expect(s.companies.length).toBeGreaterThan(0); // companies are not walled
      const tasks = (await (await r.tasks.GET(jsonReq("/api/tasks", "GET"))).json()).items as { id: number }[];
      expect(ids(tasks).includes(w.taskId)).toBe(sees);
      const tl = (await (await r.activities.GET(jsonReq(`/api/activities?company_id=${w.seller}`, "GET"))).json()).rows as { body: string }[];
      expect(tl.some((a) => a.body === "Walls note")).toBe(sees);
      const csv = await (await r.exportApi.GET(jsonReq("/api/export/deals?format=csv", "GET"), { params: Promise.resolve({ entity: "deals" }) })).text();
      expect(csv.includes("Sale of Seller Co")).toBe(sees);
      const tcsv = await (await r.exportApi.GET(jsonReq("/api/export/tasks?format=csv", "GET"), { params: Promise.resolve({ entity: "tasks" }) })).text();
      expect(tcsv.includes("Send CIM")).toBe(sees);
      const rcsv = await (await r.exportApi.GET(jsonReq("/api/export/referrals?format=csv", "GET"), { params: Promise.resolve({ entity: "referrals" }) })).text();
      expect(rcsv.includes("Rae")).toBe(sees);
      const hist = (await (await r.buyerHistory.GET(jsonReq(`/api/companies/${w.b1}/buyer-history`, "GET"), params(w.b1))).json()).items as { deal_id: number }[];
      expect(hist.some((h) => h.deal_id === w.dealId)).toBe(sees);
      const referrals = await import("../app/lib/referrals");
      const me = { id: user, role: user === w.owner ? "owner" : "member" };
      expect(referrals.referralSources(me).some((x) => x.contact_id === w.referrer && x.deals_sourced === 1)).toBe(sees);
      expect(referrals.referralCredit(w.referrer, me).deals_sourced).toBe(sees ? 1 : 0);
    }
  });

  it("creating a deal puts the creator on the team as lead, so a member can open their own deal", async () => {
    const member = await app.signIn("member");
    const co = app.company();
    const res = await r.deals.POST(jsonReq("/api/deals", "POST", { company_id: co, title: "New mandate" }));
    expect(res.status).toBe(201);
    const id = (await res.json()).item.id;
    expect(app.db.prepare("SELECT role FROM deal_team WHERE deal_id = ? AND user_id = ?").get(id, member)).toMatchObject({ role: "lead" });
    expect((await r.deal.GET(jsonReq(`/api/deals/${id}`, "GET"), params(id))).status).toBe(200);
  });

  it("access mode 'all' opens every deal to everyone", async () => {
    const w = await world();
    const { firm } = await import("../firm.config");
    const saved = firm.dealAccess;
    (firm as { dealAccess: string }).dealAccess = "all";
    try {
      await as(w.outsider);
      expect((await r.deal.GET(jsonReq(`/api/deals/${w.dealId}`, "GET"), params(w.dealId))).status).toBe(200);
    } finally {
      (firm as { dealAccess: string }).dealAccess = saved;
    }
  });
});

describe("code names", () => {
  it("PATCH saves, trims, clears and audits the code name", async () => {
    const w = await world();
    await as(w.teammate);
    const res = await r.deal.PATCH(jsonReq(`/api/deals/${w.dealId}`, "PATCH", { code_name: "  Project Juniper " }), params(w.dealId));
    expect(res.status).toBe(200);
    expect((await res.json()).item.code_name).toBe("Project Juniper");
    const a = app.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'deal.update' ORDER BY id DESC").get() as { detail_json: string };
    expect(JSON.parse(a.detail_json)).toMatchObject({ code_name: "Project Juniper", from_code_name: null });
    expect((await r.deal.PATCH(jsonReq(`/api/deals/${w.dealId}`, "PATCH", { code_name: "x".repeat(81) }), params(w.dealId))).status).toBe(400);
    await r.deal.PATCH(jsonReq(`/api/deals/${w.dealId}`, "PATCH", { code_name: "" }), params(w.dealId));
    expect(app.db.prepare("SELECT code_name FROM deals WHERE id = ?").get(w.dealId)).toMatchObject({ code_name: null });
  });

  it("the seller report, its downloads, list exports and new document titles use the code name", async () => {
    const w = await world();
    app.db.prepare("UPDATE deals SET code_name = 'Project Juniper' WHERE id = ?").run(w.dealId);
    await as(w.teammate);
    const json = await (await r.sellerReport.GET(jsonReq(`/api/deals/${w.dealId}/seller-report`, "GET"), params(w.dealId))).json();
    expect(json.deal.display_name).toBe("Project Juniper");
    const csv = await r.sellerReport.GET(jsonReq(`/api/deals/${w.dealId}/seller-report?format=csv`, "GET"), params(w.dealId));
    expect(csv.headers.get("content-disposition")).toContain("project-juniper-buyer-log");
    expect(csv.headers.get("content-disposition")).not.toMatch(/seller-co/i);
    const xlsx = await r.sellerReport.GET(jsonReq(`/api/deals/${w.dealId}/seller-report?format=xlsx`, "GET"), params(w.dealId));
    expect(xlsx.headers.get("content-disposition")).toContain("project-juniper");

    const deals = await (await r.exportApi.GET(jsonReq("/api/export/deals?format=csv", "GET"), { params: Promise.resolve({ entity: "deals" }) })).text();
    expect(deals).toContain("Project Juniper");
    expect(deals).not.toContain("Seller Co");
    const tasks = await (await r.exportApi.GET(jsonReq("/api/export/tasks?format=csv", "GET"), { params: Promise.resolve({ entity: "tasks" }) })).text();
    expect(tasks).toContain("Project Juniper");
    expect(tasks).not.toContain("Sale of Seller Co");

    const up = await (await upload({ deal_id: w.dealId, kind: "cim" })).json();
    expect(up.document.title).toBe("Project Juniper CIM");
    const named = await (await upload({ deal_id: w.dealId, kind: "other", title: "Board deck" })).json();
    expect(named.document.title).toBe("Board deck");
  });

  it("a deal with no code name keeps the company name and the file-name title", async () => {
    const w = await world();
    await as(w.teammate);
    const json = await (await r.sellerReport.GET(jsonReq(`/api/deals/${w.dealId}/seller-report`, "GET"), params(w.dealId))).json();
    expect(json.deal.display_name).toBe("Seller Co");
    const up = await (await upload({ deal_id: w.dealId, kind: "cim" })).json();
    expect(up.document.title).toBe("Seller Co teaser");
  });

  it("search finds a deal by its code name, only for people who can see it", async () => {
    const w = await world();
    app.db.prepare("UPDATE deals SET code_name = 'Project Juniper' WHERE id = ?").run(w.dealId);
    await as(w.teammate);
    expect((await (await r.search.GET(jsonReq("/api/search?q=Juniper", "GET"))).json()).deals.map((d: { id: number }) => d.id)).toEqual([w.dealId]);
    await as(w.outsider);
    expect((await (await r.search.GET(jsonReq("/api/search?q=Juniper", "GET"))).json()).deals).toEqual([]);
  });

  it("maskDeal hides the company, people, place and notes; deals without a code name are untouched", async () => {
    const { maskDeal, dealDisplayName } = await import("../app/lib/codeNames");
    const base = {
      title: "Sale of Seller Co",
      company_name: "Seller Co",
      company_domain: "seller.example",
      company_city: "Dallas",
      company_state: "TX",
      primary_contact_name: "Pat Lee",
      known_names: "Pat Lee",
      last_note: "Called Pat at Seller Co",
    };
    const m = maskDeal({ ...base, code_name: "Project Falcon" });
    expect(m).toMatchObject({ title: "Project Falcon", company_name: "Project Falcon", masked: true, company_city: null, primary_contact_name: null, known_names: null, last_note: null });
    expect(JSON.stringify(m)).not.toContain("Seller Co");
    expect(maskDeal({ ...base, code_name: null })).toEqual({ ...base, code_name: null });
    expect(dealDisplayName({ code_name: " ", company_name: "Seller Co" })).toBe("Seller Co");
  });
});

describe("buyer conflict check", () => {
  async function conflictWorld() {
    const w = await world();
    // Buyer Three sells on its own open mandate, which the teammate is not on.
    const otherDeal = app.deal(w.b3, "Engaged", "Sale of Buyer Three");
    // Buyer Four is at LOI on a third open deal the teammate IS on.
    const b4 = app.company("Buyer Four");
    const third = app.deal(app.company("Third Seller"), "LOI", "Third mandate");
    app.db.prepare("UPDATE deals SET code_name = 'Project Harbor' WHERE id = ?").run(third);
    app.insert("deal_team", { deal_id: third, user_id: w.teammate, role: "coverage" });
    app.insert("deal_buyers", { deal_id: third, buyer_company_id: b4, stage: "loi" });
    // The referral source works at Buyer Five.
    const b5 = app.company("Buyer Five");
    app.db.prepare("UPDATE contacts SET company_id = ? WHERE id = ?").run(b5, w.referrer);
    const clean = app.company("Clean Buyer");
    return { ...w, otherDeal, b4, third, b5, clean };
  }

  it("flags seller-elsewhere, LOI-elsewhere and referral-firm buyers, never blocks, and audits each", async () => {
    const w = await conflictWorld();
    await as(w.teammate);
    const res = await r.buyers.POST(
      jsonReq("/api/deal-buyers", "POST", {
        deal_id: w.dealId,
        buyers: [{ buyer_company_id: w.b3 }, { buyer_company_id: w.b4 }, { buyer_company_id: w.b5 }, { buyer_company_id: w.clean }],
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toHaveLength(4); // nothing was blocked
    const byCo = new Map((body.warnings as { buyer_company_id: number; kind: string; other_deal_id: number | null; message: string }[]).map((x) => [x.buyer_company_id, x]));
    expect(byCo.get(w.b3)).toMatchObject({ kind: "seller_elsewhere", other_deal_id: null });
    // The teammate is not on Buyer Three's mandate: the warning must not name it or say what it is.
    expect(byCo.get(w.b3)!.message).not.toMatch(/Sale of Buyer Three|seller/i);
    expect(byCo.get(w.b4)).toMatchObject({ kind: "buyer_late_elsewhere", other_deal_id: w.third });
    expect(byCo.get(w.b4)!.message).toContain("Project Harbor");
    expect(byCo.get(w.b5)).toMatchObject({ kind: "referral_firm" });
    expect(byCo.get(w.b5)!.message).toContain("Rae");
    expect(byCo.has(w.clean)).toBe(false);
    const flagged = app.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'conflict.flagged'").all() as { detail_json: string }[];
    expect(flagged).toHaveLength(3);
    expect(flagged.map((f) => JSON.parse(f.detail_json)).find((d) => d.buyer_company_id === w.b3)).toMatchObject({ other_deal_id: w.otherDeal });
  });

  it("an owner sees the hidden deal named, and closed deals or declined buyers are not conflicts", async () => {
    const w = await conflictWorld();
    await as(w.owner);
    const body = await (await r.buyers.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: w.dealId, buyers: [{ buyer_company_id: w.b3 }] }))).json();
    expect(body.warnings[0]).toMatchObject({ kind: "seller_elsewhere", other_deal_id: w.otherDeal });
    expect(body.warnings[0].message).toContain("Sale of Buyer Three");

    app.db.prepare("UPDATE deals SET stage = 'Passed' WHERE id = ?").run(w.otherDeal);
    app.db.prepare("UPDATE deal_buyers SET stage = 'declined', decline_reason = 'price' WHERE deal_id = ? AND buyer_company_id = ?").run(w.third, w.b4);
    const again = await (await r.buyers.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: w.dealId, buyers: [{ buyer_company_id: w.b4 }] }))).json();
    expect(again.warnings).toEqual([]);
  });

  it("re-adding a buyer already on the log is skipped and not re-flagged", async () => {
    const w = await conflictWorld();
    await as(w.owner);
    await r.buyers.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: w.dealId, buyers: [{ buyer_company_id: w.b3 }] }));
    const second = await (await r.buyers.POST(jsonReq("/api/deal-buyers", "POST", { deal_id: w.dealId, buyers: [{ buyer_company_id: w.b3 }] }))).json();
    expect(second.skipped).toHaveLength(1);
    expect(second.warnings).toEqual([]);
    expect((app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'conflict.flagged'").get() as { n: number }).n).toBe(1);
  });

  it("company page conflict: seller on one open deal and a buyer on another, visible deals only", async () => {
    const w = await conflictWorld();
    // Seller Co is the seller on w.dealId; make it a live buyer on the third deal.
    app.insert("deal_buyers", { deal_id: w.third, buyer_company_id: w.seller, stage: "cim_sent" });
    const { companyConflicts } = await import("../app/lib/conflicts");
    const teammate = { id: w.teammate, role: "member" };
    expect(companyConflicts(w.seller, teammate)).toEqual([
      { sellerDeal: { id: w.dealId, label: "Sale of Seller Co" }, buyerDeal: { id: w.third, label: "Project Harbor", stage: "cim_sent" } },
    ]);
    // The outsider can see neither deal, so there is no line to show.
    expect(companyConflicts(w.seller, { id: w.outsider, role: "member" })).toEqual([]);
    // A declined buyer is no longer a conflict.
    app.db.prepare("UPDATE deal_buyers SET stage = 'declined', decline_reason = 'fit' WHERE deal_id = ? AND buyer_company_id = ?").run(w.third, w.seller);
    expect(companyConflicts(w.seller, teammate)).toEqual([]);
  });
});

describe("People admin: deal access", () => {
  it("counts the deals each person can see, and the team API adds and removes them (owner)", async () => {
    const w = await world();
    const access = await import("../app/lib/dealAccess");
    const second = app.deal(app.company(), "Sourced");
    expect(access.visibleDealCount({ id: w.owner, role: "owner" })).toBe(2);
    expect(access.visibleDealCount({ id: w.teammate, role: "member" })).toBe(1);
    expect(access.visibleDealCount({ id: w.outsider, role: "member" })).toBe(0);
    await as(w.owner);
    expect((await r.team.POST(jsonReq(`/api/deals/${second}/team`, "POST", { user_id: w.outsider, role: "analyst" }), params(second))).status).toBe(201);
    expect(access.visibleDealCount({ id: w.outsider, role: "member" })).toBe(1);
    expect((await r.team.DELETE(jsonReq(`/api/deals/${second}/team?user_id=${w.outsider}`, "DELETE"), params(second))).status).toBe(200);
    expect(access.visibleDealCount({ id: w.outsider, role: "member" })).toBe(0);
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action IN ('deal.team.add','deal.team.remove')").get()).toMatchObject({ n: 2 });
  });

  it("visibleDealIds is a bound-parameter fragment, never an interpolated id", async () => {
    const { visibleDealIds } = await import("../app/lib/dealAccess");
    const f = visibleDealIds({ id: 42, role: "member" }, "t.deal_id", { nullable: true });
    expect(f.sql).not.toContain("42");
    expect(f.params).toEqual([42, 42]);
    expect(f.sql).toMatch(/^\(t\.deal_id IS NULL OR /);
    expect(visibleDealIds({ id: 1, role: "owner" })).toEqual({ sql: "1 = 1", params: [] });
  });
});
