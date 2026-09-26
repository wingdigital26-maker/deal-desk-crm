// P3 RELATIONSHIPS + FINDABILITY: contact_companies junction, referral credit,
// global search and list exports, against a real temp database.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieMock, freshApp, params, jsonReq, cleanup, harness, type App } from "./_harness";

vi.mock("next/headers", () => cookieMock());

let app: App;
let links: typeof import("../app/api/contacts/[id]/companies/route");
let contactsApi: typeof import("../app/api/contacts/route");
let contactApi: typeof import("../app/api/contacts/[id]/route");
let dealApi: typeof import("../app/api/deals/[id]/route");
let searchApi: typeof import("../app/api/search/route");
let exportApi: typeof import("../app/api/export/[entity]/route");
let referrals: typeof import("../app/lib/referrals");
let search: typeof import("../app/lib/search");

beforeEach(async () => {
  vi.resetModules();
  app = await freshApp();
  links = await import("../app/api/contacts/[id]/companies/route");
  contactsApi = await import("../app/api/contacts/route");
  contactApi = await import("../app/api/contacts/[id]/route");
  dealApi = await import("../app/api/deals/[id]/route");
  searchApi = await import("../app/api/search/route");
  exportApi = await import("../app/api/export/[entity]/route");
  referrals = await import("../app/lib/referrals");
  search = await import("../app/lib/search");
});
afterEach(cleanup);

const count = (sql: string, ...args: (string | number)[]) => (app.db.prepare(sql).get(...args) as { n: number }).n;
const auditCount = (action: string) => count("SELECT COUNT(*) n FROM audit_log WHERE action = ?", action);
const linkReq = (contactId: number, method: string, body?: unknown, qs = "") =>
  (links as unknown as Record<string, (r: Request, c: ReturnType<typeof params>) => Promise<Response>>)[method](
    jsonReq(`/api/contacts/${contactId}/companies${qs}`, method, body),
    params(contactId)
  );

describe("3.1 contact_companies junction", () => {
  it("migration copies every existing company link once and is idempotent", async () => {
    const a = app.company("Alpha");
    const b = app.company("Beta");
    const c1 = app.contact({ company_id: a });
    const c2 = app.contact({ company_id: b });
    app.contact(); // no company: nothing to copy
    // Rows written straight to contacts (an old database) have no junction row yet.
    expect(count("SELECT COUNT(*) n FROM contact_companies")).toBe(0);

    // Re-open the database twice: migrate() runs each time.
    for (let i = 0; i < 2; i++) {
      vi.resetModules();
      const dbm = await import("../app/lib/db");
      const d = dbm.db();
      expect((d.prepare("SELECT COUNT(*) n FROM contact_companies").get() as { n: number }).n).toBe(2);
      const rows = d.prepare("SELECT contact_id, company_id, is_primary FROM contact_companies ORDER BY contact_id").all();
      expect(rows).toEqual([
        { contact_id: c1, company_id: a, is_primary: 1 },
        { contact_id: c2, company_id: b, is_primary: 1 },
      ]);
    }
  });

  it("a contact can hold two companies, and marking one primary moves contacts.company_id", async () => {
    await app.signIn();
    const owner = app.company("Owner Co");
    const cpa = app.company("CPA Firm");
    const res = await contactsApi.POST(jsonReq("/api/contacts", "POST", { first_name: "Dana", last_name: "Reyes", company_id: cpa }));
    const { id } = await res.json();
    // The create flow wrote the primary link.
    expect(app.db.prepare("SELECT company_id, is_primary FROM contact_companies WHERE contact_id = ?").all(id)).toEqual([{ company_id: cpa, is_primary: 1 }]);

    const add = await linkReq(id, "POST", { company_id: owner, role: "Board member", start_date: "2021-03-01" });
    expect(add.status).toBe(201);
    const list = await (await linkReq(id, "GET")).json();
    expect(list.items.map((l: { company_id: number }) => l.company_id).sort()).toEqual([owner, cpa].sort());
    expect(list.items.find((l: { company_id: number }) => l.company_id === owner)).toMatchObject({ role: "Board member", is_primary: 0 });

    const dup = await linkReq(id, "POST", { company_id: owner });
    expect(dup.status).toBe(409);

    const patch = await linkReq(id, "PATCH", { company_id: owner, is_primary: true, role: "Chair" });
    expect(patch.status).toBe(200);
    expect(app.db.prepare("SELECT company_id FROM contacts WHERE id = ?").get(id)).toEqual({ company_id: owner });
    expect(count("SELECT COUNT(*) n FROM contact_companies WHERE contact_id = ? AND is_primary = 1", id)).toBe(1);

    const bad = await linkReq(id, "PATCH", { company_id: owner, start_date: "2022-01-01", end_date: "2021-01-01" });
    expect(bad.status).toBe(400);

    const del = await linkReq(id, "DELETE", undefined, `?company_id=${owner}`);
    expect(del.status).toBe(200);
    expect(app.db.prepare("SELECT company_id FROM contacts WHERE id = ?").get(id)).toEqual({ company_id: null });
    expect(count("SELECT COUNT(*) n FROM contact_companies WHERE contact_id = ?", id)).toBe(1);

    expect(auditCount("contact.company.link")).toBe(1);
    expect(auditCount("contact.company.update")).toBe(1);
    expect(auditCount("contact.company.unlink")).toBe(1);
  });

  it("editing a contact's company writes the junction too", async () => {
    await app.signIn();
    const a = app.company();
    const b = app.company();
    const id = app.contact();
    await contactApi.PATCH(jsonReq(`/api/contacts/${id}`, "PATCH", { company_id: a }), params(id));
    await contactApi.PATCH(jsonReq(`/api/contacts/${id}`, "PATCH", { company_id: b }), params(id));
    expect(app.db.prepare("SELECT company_id, is_primary FROM contact_companies WHERE contact_id = ? ORDER BY company_id").all(id)).toEqual([
      { company_id: a, is_primary: 0 },
      { company_id: b, is_primary: 1 },
    ]);
  });

  it("unknown company is a 400 and signed out is a 401", async () => {
    await app.signIn();
    const id = app.contact();
    expect((await linkReq(id, "POST", { company_id: 99999 })).status).toBe(400);
    harness.token = undefined;
    expect((await linkReq(id, "GET")).status).toBe(401);
  });
});

describe("3.2 referral sources and credit", () => {
  async function setup() {
    await app.signIn();
    const cpa = app.contact({ first_name: "Casey", referral_kind: "cpa" });
    const lawyer = app.contact({ first_name: "Lee", referral_kind: "attorney" });
    const co = app.company();
    const open1 = app.deal(co, "Engaged");
    const open2 = app.deal(co, "NDA");
    const won = app.deal(co, "Closed");
    const lost = app.deal(co, "Passed");
    app.db.prepare("UPDATE deals SET retainer = 50000, success_fee_pct = 3, enterprise_value = 20000000 WHERE id = ?").run(won);
    for (const d of [open1, open2, won, lost]) app.db.prepare("UPDATE deals SET referral_contact_id = ? WHERE id = ?").run(cpa, d);
    return { cpa, lawyer, open1, won };
  }

  it("credit counts match the deals", async () => {
    const { cpa, lawyer } = await setup();
    const rows = referrals.referralSources();
    const c = rows.find((r) => r.contact_id === cpa)!;
    expect(c).toMatchObject({ deals_sourced: 4, open: 2, won: 1, lost: 1, won_fees: 50000 + 600000, won_without_fee: 0 });
    expect(rows.find((r) => r.contact_id === lawyer)).toMatchObject({ deals_sourced: 0, open: 0, won: 0, won_fees: 0 });
    // Someone not marked as a source but credited on a deal still shows.
    const plain = app.contact({ first_name: "Pat" });
    const d = app.deal(app.company(), "Sourced");
    app.db.prepare("UPDATE deals SET referral_contact_id = ? WHERE id = ?").run(plain, d);
    expect(referrals.referralSources().find((r) => r.contact_id === plain)).toMatchObject({ deals_sourced: 1, open: 1, referral_kind: null });
  });

  it("changing a deal's source moves the credit (PATCH validated and audited)", async () => {
    const { cpa, lawyer, won } = await setup();
    const res = await dealApi.PATCH(jsonReq(`/api/deals/${won}`, "PATCH", { referral_contact_id: lawyer }), params(won));
    expect(res.status).toBe(200);
    const rows = referrals.referralSources();
    expect(rows.find((r) => r.contact_id === cpa)).toMatchObject({ deals_sourced: 3, won: 0, won_fees: 0 });
    expect(rows.find((r) => r.contact_id === lawyer)).toMatchObject({ deals_sourced: 1, won: 1, won_fees: 650000 });
    const a = app.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'deal.update' ORDER BY id DESC").get() as { detail_json: string };
    expect(JSON.parse(a.detail_json)).toMatchObject({ referral_contact_id: lawyer, from_referral_contact_id: cpa });

    expect((await dealApi.PATCH(jsonReq(`/api/deals/${won}`, "PATCH", { referral_contact_id: 99999 }), params(won))).status).toBe(400);
    expect((await dealApi.PATCH(jsonReq(`/api/deals/${won}`, "PATCH", { referral_contact_id: "abc" }), params(won))).status).toBe(400);
    expect((await dealApi.PATCH(jsonReq(`/api/deals/${won}`, "PATCH", { referral_contact_id: null }), params(won))).status).toBe(200);
    expect(referrals.referralSources().find((r) => r.contact_id === lawyer)).toMatchObject({ deals_sourced: 0 });
  });

  it("referral_kind is validated on the contact PATCH", async () => {
    await app.signIn();
    const id = app.contact();
    expect((await contactApi.PATCH(jsonReq(`/api/contacts/${id}`, "PATCH", { referral_kind: "astrologer" }), params(id))).status).toBe(400);
    expect((await contactApi.PATCH(jsonReq(`/api/contacts/${id}`, "PATCH", { referral_kind: "wealth-manager" }), params(id))).status).toBe(200);
    expect(app.db.prepare("SELECT referral_kind FROM contacts WHERE id = ?").get(id)).toEqual({ referral_kind: "wealth-manager" });
  });

  it("deleting a credited contact clears the credit instead of leaving a dangling id", async () => {
    const { cpa, open1 } = await setup();
    const res = await contactApi.DELETE(jsonReq(`/api/contacts/${cpa}`, "DELETE"), params(cpa));
    expect(res.status).toBe(200);
    expect(app.db.prepare("SELECT referral_contact_id FROM deals WHERE id = ?").get(open1)).toEqual({ referral_contact_id: null });
  });

  it("won and lost stages come from the config, not hard-coded names", () => {
    expect(referrals.outcomeStages({ closedStages: ["Won", "Lost"], stageProbability: { Won: 100, Lost: 0 } })).toEqual({ won: ["Won"], lost: ["Lost"] });
  });
});

describe("3.3 global search", () => {
  it("one query returns all three kinds", async () => {
    await app.signIn();
    const co = app.company("Harbor Lane Supply", { domain: "harborlane.example" });
    app.contact({ first_name: "Robin", last_name: "Harbor", company_id: co });
    app.deal(co, "Engaged", "Harbor Lane succession");
    const res = await searchApi.GET(jsonReq("/api/search?q=harbor", "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.companies.length).toBe(1);
    expect(body.contacts.length).toBe(1);
    expect(body.contacts[0].company_name).toBe("Harbor Lane Supply");
    expect(body.deals.length).toBe(1);
  });

  it("empty or blank query shows nothing, not everything", async () => {
    await app.signIn();
    app.company("Anything");
    app.contact();
    for (const q of ["", "   ", null]) {
      const r = search.globalSearch(q);
      expect([r.companies.length, r.contacts.length, r.deals.length]).toEqual([0, 0, 0]);
    }
    const body = await (await searchApi.GET(jsonReq("/api/search?q=%20", "GET"))).json();
    expect(body).toMatchObject({ companies: [], contacts: [], deals: [] });
  });

  it("caps at 8 per kind, matches full names and treats % literally", async () => {
    await app.signIn();
    for (let i = 0; i < 12; i++) app.company(`Cedar ${i}`);
    app.company("100% Cedar Holdings");
    app.contact({ first_name: "Morgan", last_name: "Vale" });
    expect(search.globalSearch("cedar").companies.length).toBe(8);
    expect(search.globalSearch("100%").companies.map((c) => c.name)).toEqual(["100% Cedar Holdings"]);
    expect(search.globalSearch("Morgan Vale").contacts.length).toBe(1);
  });

  it("401 when signed out", async () => {
    harness.token = undefined;
    expect((await searchApi.GET(jsonReq("/api/search?q=a", "GET"))).status).toBe(401);
  });
});

describe("3.4 exports", () => {
  const ENTITIES = ["companies", "contacts", "deals", "tasks", "referrals"];
  const get = (entity: string, qs = "") => exportApi.GET(jsonReq(`/api/export/${entity}${qs}`, "GET"), { params: Promise.resolve({ entity }) });

  it("each export route 401s signed out", async () => {
    for (const e of ENTITIES) expect((await get(e, "?format=csv")).status).toBe(401);
  });

  it("each export returns the right content type for csv and xlsx, and audits the row count", async () => {
    await app.signIn();
    const co = app.company("Export Co");
    const c = app.contact({ company_id: co, referral_kind: "cpa" });
    const d = app.deal(co);
    app.db.prepare("UPDATE deals SET referral_contact_id = ? WHERE id = ?").run(c, d);
    app.insert("tasks", { title: "Call back", deal_id: d });
    for (const e of ENTITIES) {
      const csv = await get(e, "?format=csv");
      expect(csv.status).toBe(200);
      expect(csv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
      expect(csv.headers.get("Content-Disposition")).toMatch(/attachment; filename=".+\.csv"/);
      const xlsx = await get(e, "?format=xlsx");
      expect(xlsx.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const bytes = Buffer.from(await xlsx.arrayBuffer());
      expect(bytes.subarray(0, 2).toString()).toBe("PK");
      expect(auditCount(`export.${e}`)).toBe(2);
      const a = app.db.prepare("SELECT detail_json FROM audit_log WHERE action = ? ORDER BY id DESC").get(`export.${e}`) as { detail_json: string };
      expect(JSON.parse(a.detail_json).rows).toBe(1);
    }
  });

  it("unknown entity is a 404", async () => {
    await app.signIn();
    expect((await get("users", "?format=csv")).status).toBe(404);
  });

  it("CSV escapes a formula-looking name", async () => {
    await app.signIn();
    app.company("=SUM(A1:A9)");
    app.contact({ first_name: "=HYPERLINK(\"x\")", last_name: "Doe" });
    const text = await (await get("companies", "?format=csv")).text();
    expect(text).toContain("'=SUM(A1:A9)");
    expect(text).not.toMatch(/(^|,)=SUM/m);
    const contacts = await (await get("contacts", "?format=csv")).text();
    expect(contacts).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("companies and contacts exports respect the list filters", async () => {
    await app.signIn();
    app.company("Pine Ridge", { segment_id: "owners" });
    app.company("Pine Bank", { segment_id: "institutions" });
    app.company("Oak Hill", { segment_id: "owners" });
    const text = await (await get("companies", "?format=csv&q=pine&segment=owners")).text();
    expect(text).toContain("Pine Ridge");
    expect(text).not.toContain("Pine Bank");
    expect(text).not.toContain("Oak Hill");

    const bank = app.db.prepare("SELECT id FROM companies WHERE name = 'Pine Bank'").get() as { id: number };
    app.contact({ first_name: "Inst", company_id: bank.id });
    app.contact({ first_name: "Loose" });
    const ctext = await (await get("contacts", "?format=csv&segment=institutions")).text();
    expect(ctext).toContain("Inst");
    expect(ctext).not.toContain("Loose");
  });

  it("deals export carries the economics columns from dealMath", async () => {
    await app.signIn();
    const d = app.deal(app.company("Econ Co"), "Engaged");
    app.db.prepare("UPDATE deals SET retainer = 100000, success_fee_pct = 2, enterprise_value = 50000000 WHERE id = ?").run(d);
    const text = await (await get("deals", "?format=csv")).text();
    const [head, row] = text.replace(/^﻿/, "").trim().split("\r\n");
    const cols = head.split(",");
    const cells = row.split(",");
    expect(cells[cols.indexOf("Expected fee")]).toBe("1100000");
    // Engaged stage default is 40% in firm.config.ts.
    expect(cells[cols.indexOf("Weighted fee")]).toBe("440000");
    expect(cells[cols.indexOf("Probability from")]).toBe("Stage default");
  });
});
