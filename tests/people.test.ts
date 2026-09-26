// The pipe is one company and the people there the banker knows (2026-09-26).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieMock, freshApp, params, jsonReq, cleanup, type App } from "./_harness";

vi.mock("next/headers", () => cookieMock());

let app: App;
beforeEach(async () => {
  vi.resetModules();
  app = await freshApp();
});
afterEach(cleanup);

describe("people at a deal's company", () => {
  it("lists everyone at the company, best-known first, including junction links", async () => {
    const { peopleAtCompany } = await import("../app/lib/companyPeople");
    const co = app.company("Acme Co");
    const met = app.contact({ company_id: co, first_name: "Met", relationship: "met" });
    const well = app.contact({ company_id: co, first_name: "Well", relationship: "knows-well" });
    const unset = app.contact({ company_id: co, first_name: "Unset" });
    const elsewhere = app.contact({ company_id: app.company(), first_name: "Board" });
    app.insert("contact_companies", { contact_id: elsewhere, company_id: co, role: "Board member" });
    app.contact({ company_id: app.company(), first_name: "Stranger" });
    const ids = peopleAtCompany(co).map((p) => p.id);
    expect(ids.slice(0, 2)).toEqual([well, met]);
    expect(ids).toContain(unset);
    expect(ids).toContain(elsewhere);
    expect(ids.length).toBe(4);
  });

  it("PATCH sets and clears how well the banker knows someone, and rejects nonsense", async () => {
    const route = await import("../app/api/contacts/[id]/route");
    await app.signIn();
    const c = app.contact();
    expect((await route.PATCH(jsonReq(`/api/contacts/${c}`, "PATCH", { relationship: "knows" }), params(c))).status).toBe(200);
    expect((app.db.prepare("SELECT relationship FROM contacts WHERE id = ?").get(c) as { relationship: string }).relationship).toBe("knows");
    expect((await route.PATCH(jsonReq(`/api/contacts/${c}`, "PATCH", { relationship: "bestie" }), params(c))).status).toBe(400);
    await route.PATCH(jsonReq(`/api/contacts/${c}`, "PATCH", { relationship: null }), params(c));
    expect((app.db.prepare("SELECT relationship FROM contacts WHERE id = ?").get(c) as { relationship: string | null }).relationship).toBeNull();
  });

  it("the deals list carries people counts and the names the banker knows", async () => {
    const route = await import("../app/api/deals/route");
    await app.signIn();
    const co = app.company("Acme Co");
    app.deal(co);
    app.contact({ company_id: co, first_name: "Ann", last_name: "Lee", relationship: "knows-well" });
    app.contact({ company_id: co, first_name: "Bo", last_name: "Diaz", relationship: "met" });
    const body = await (await route.GET(jsonReq("/api/deals", "GET"))).json();
    expect(body.items[0]).toMatchObject({ people_count: 2, known_count: 1, known_names: "Ann Lee" });
  });
});
