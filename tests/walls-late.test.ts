// Features built in parallel with the MNPI walls (morning brief, buyer
// follow-ups, 4Degrees import) must respect them too.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieMock, freshApp, params, jsonReq, cleanup, type App } from "./_harness";

vi.mock("next/headers", () => cookieMock());

let app: App;
beforeEach(async () => {
  vi.resetModules();
  app = await freshApp();
});
afterEach(cleanup);

function setup() {
  const hiddenDeal = app.deal(app.company("Hidden Seller"), "In Market");
  const buyer = app.insert("deal_buyers", { deal_id: hiddenDeal, buyer_company_id: app.company("Secret Buyer"), next_step: "Chase NDA", next_step_due: "2020-01-01" });
  app.insert("tasks", { title: "Hidden task", due: "2020-01-01", deal_id: hiddenDeal });
  return { hiddenDeal, buyer };
}

describe("late features behind the wall", () => {
  it("the morning brief hides deals, tasks and buyers the user is not cleared for", async () => {
    const { loadBrief } = await import("../app/lib/brief");
    const member = await app.signIn("member");
    setup();
    const brief = loadBrief("2026-09-28", { id: member, role: "member" });
    const text = JSON.stringify(brief);
    expect(text).not.toContain("Hidden Seller");
    expect(text).not.toContain("Secret Buyer");
    expect(text).not.toContain("Hidden task");
  });

  it("a teammate sees the same items", async () => {
    const { loadBrief } = await import("../app/lib/brief");
    const member = await app.signIn("member");
    const { hiddenDeal } = setup();
    app.insert("deal_team", { deal_id: hiddenDeal, user_id: member, role: "execution" });
    const text = JSON.stringify(loadBrief("2026-09-28", { id: member, role: "member" }));
    expect(text).toContain("Secret Buyer");
  });

  it("4Degrees import onto a hidden deal answers 404 and writes nothing", async () => {
    const route = await import("../app/api/deals/[id]/import-buyers/route");
    await app.signIn("member");
    const { hiddenDeal } = setup();
    const res = await route.POST(
      jsonReq(`/api/deals/${hiddenDeal}/import-buyers`, "POST", { csv: "Company\nAcme", mapping: { company: "Company" } }),
      params(hiddenDeal)
    );
    expect(res.status).toBe(404);
    expect((app.db.prepare("SELECT COUNT(*) n FROM deal_buyers WHERE deal_id = ?").get(hiddenDeal) as { n: number }).n).toBe(1);
  });
});
