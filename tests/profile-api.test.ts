// The banker profile: buildProfile / match discipline in app/lib/profile.ts, and
// the three API routes (company profile, contact profile, owner-only refresh).
// The refresh runner is mocked, so no Python and no network run here.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.stubGlobal(
  "fetch",
  vi.fn(() => {
    throw new Error("network I/O attempted in profile-api test");
  })
);

const session = { role: "owner" as "owner" | "principal" | "member" };
vi.mock("../app/lib/session", () => ({
  requireUser: vi.fn(async (roles?: string[]) => {
    const user = { id: 1, email: "owner@example.com", name: "Owner", role: session.role };
    if (roles && !roles.includes(user.role)) return Response.json({ error: "Not allowed for this role" }, { status: 403 });
    return user;
  }),
}));

const runner = { impl: vi.fn() };
vi.mock("../app/lib/profileRun", () => ({
  runProfileRefresh: (id: number) => runner.impl(id),
}));

let tmpDir: string;
let dbModule: typeof import("../app/lib/db");

async function freshDb() {
  tmpDir = mkdtempSync(path.join(tmpdir(), "harness-profile-"));
  process.env.HARNESS_DB_PATH = path.join(tmpDir, "test.db");
  vi.resetModules();
  dbModule = await import("../app/lib/db");
  const d = dbModule.db();
  d.prepare("INSERT INTO users (id, email, name, role, password_hash) VALUES (1,'owner@example.com','Owner','owner','x')").run();
  d.prepare(
    "INSERT INTO companies (id, name, domain, industry, city, state, employees, revenue_band, source) VALUES (10,'Acme Precision','acmeprecision.com','Machining','Haltom City','TX',80,'16416000','apollo')"
  ).run();
  d.prepare("INSERT INTO contacts (id, company_id, first_name, last_name, title, source) VALUES (5,10,'Walter','Br***t','President','apollo')").run();
  d.prepare("INSERT INTO contacts (id, company_id, first_name, last_name, title, source) VALUES (6,10,'Pat','Lee','COO','apollo')").run();
  const fact = d.prepare(
    "INSERT INTO profile_facts (entity, entity_id, field, value, value_key, source_url, source_label, confidence, note, observed_at, fetched_at) VALUES ('company',10,?,?,?,?,?,?,?,?, '2026-09-25 12:00:00')"
  );
  const site = "https://acmeprecision.com/about-us/";
  fact.run("owner_name", "Walter Brandt", "", site, "Company website", "confirmed", null, null);
  fact.run("owner_title", "President, founder", "", site, "Company website", "confirmed", null, null);
  fact.run("leaders", "Walter Brandt | President, founder", "walterbrandtpresidentfounder", site, "Company website", "confirmed", null, null);
  fact.run("founded_year", "1979", "", site, "Company website", "confirmed", null, null);
  fact.run("family_owned_since", "1979", "", site, "Company website", "confirmed", null, null);
  fact.run("formation_date", "1981-02-10", "", "https://data.texas.gov/resource/9cir-efmm.json?x", "TX Comptroller franchise-tax registry", "confirmed", null, null);
  fact.run("entity_type", "Texas for-profit corporation", "", "https://data.texas.gov/resource/9cir-efmm.json?x", "TX Comptroller franchise-tax registry", "confirmed", null, null);
  fact.run("certifications", "ISO 9001", "iso9001", site, "Company website", "confirmed", null, null);
  fact.run("signal_facility", "Acme Precision moves into a new plant", "acmeprecisionmovesintoanewplant", "https://acmeprecision.com/news", "Company website", "confirmed", null, "2026-03-01");
  fact.run("ownership_event", "sold: Big Co acquires Acme Precision", "soldbigcoacquiresacmeprecision", "https://news.example/1", "news", "unconfirmed", "Big Co acquires Acme Precision", "2025-05-01");
  const sig = d.prepare("INSERT INTO signals (company_id, kind, title, url, observed_at) VALUES (10,?,?,?,?)");
  sig.run("news", "Initech announces expansion in Indiana", "https://fab.example/j", "2017-02-03"); // false attribution
  sig.run("news", "Acme Precision expands in Haltom City", "https://biz.example/a", "2026-06-01"); // name + city
  sig.run("news", "Acme Precision wins award", "https://biz.example/b", "2025-06-01"); // name only
  sig.run("contract", "$16,222 federal award from Department of Defense", "https://www.usaspending.gov/award/1", null);
}

beforeEach(async () => {
  session.role = "owner";
  runner.impl = vi.fn();
  await freshDb();
});
afterEach(() => {
  delete process.env.HARNESS_DB_PATH;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the open SQLite file locked; the OS temp dir is cleaned later
  }
});

const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

describe("profile lib", () => {
  it("builds owner and business fields with their sources, blanks stay null", async () => {
    const { getCompanyProfile } = await import("../app/lib/profile");
    const p = getCompanyProfile(10)!;
    expect(p.owner.name).toMatchObject({ value: "Walter Brandt", sourceUrl: "https://acmeprecision.com/about-us/", confidence: "confirmed" });
    expect(p.owner.bio).toBeNull();
    expect(p.owner.since).toBeNull();
    expect(p.business.formationDate?.sourceLabel).toBe("TX Comptroller franchise-tax registry");
    expect(p.business.revenueBand).toMatchObject({ value: "about $16M", sourceUrl: null, sourceLabel: "CRM record (Apollo import)" });
    expect(p.business.naics).toBeNull();
    expect(p.business.certifications.map((c) => c.value)).toEqual(["ISO 9001"]);
  });

  it("why-now drops headlines that do not name the company and labels name-only ones", async () => {
    const { getCompanyProfile } = await import("../app/lib/profile");
    const titles = getCompanyProfile(10)!.whyNow.map((w) => `${w.confidence}:${w.title}`);
    expect(titles.some((t) => t.includes("Initech"))).toBe(false);
    expect(titles).toContain("confirmed:Acme Precision expands in Haltom City");
    expect(titles).toContain("unconfirmed:Acme Precision wins award");
    expect(titles).toContain("unconfirmed:$16,222 federal award from Department of Defense");
    // confirmed first
    expect(titles[0].startsWith("confirmed")).toBe(true);
  });

  it("fit flags: name-only sale news is a possible poor fit, never a confirmed one", async () => {
    const { getCompanyProfile } = await import("../app/lib/profile");
    const fit = getCompanyProfile(10)!.fit;
    expect(fit).toHaveLength(1);
    expect(fit[0]).toMatchObject({ level: "possible" });
    expect(fit[0].text).toMatch(/Already sold/);
  });

  it("sell-readiness hints are drawn from sourced facts", async () => {
    const { getCompanyProfile } = await import("../app/lib/profile");
    const hints = getCompanyProfile(10)!.hints.map((h) => h.text);
    expect(hints.some((h) => /^Founder-led: Walter Brandt founded it in 1979/.test(h))).toBe(true);
    expect(hints.some((h) => /late career/.test(h))).toBe(true);
    expect(hints).toContain("Family owned since 1979");
    expect(hints).toContain("No second generation named on the company site");
    expect(hints.some((h) => /^Recent capex or facility move: Acme Precision moves into a new plant/.test(h))).toBe(true);
    for (const h of getCompanyProfile(10)!.hints) expect(h.basis.length).toBeGreaterThan(0);
  });

  it("matches an Apollo-masked surname to the site's full name", async () => {
    const { samePerson, matchSignal, formatRevenue } = await import("../app/lib/profile");
    expect(samePerson("Walter Brandt", "Walter", "Br***t")).toBe(true);
    expect(samePerson("Walter Brandt", "Walter", "Ma***d")).toBe(false);
    expect(samePerson("Karen Brandt", "Walter", "Brandt")).toBe(false);
    expect(matchSignal("Premier Manufacturing wins bid", null, { name: "Premier Manufacturing", domain: null, city: "Houston", state: "TX" })).toBe("unconfirmed");
    expect(matchSignal("Premier Manufacturing opens Texas plant", null, { name: "Premier Manufacturing", domain: null, city: "Houston", state: "TX" })).toBe("confirmed");
    expect(formatRevenue("331000")).toBe("about $331K");
    expect(formatRevenue("$10M-$50M")).toBe("$10M-$50M");
  });
});

describe("GET /api/companies/[id]/profile", () => {
  it("returns the profile", async () => {
    const { GET } = await import("../app/api/companies/[id]/profile/route");
    const res = await GET(new Request("http://x"), params(10));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.owner.name.value).toBe("Walter Brandt");
  });
  it("404s an unknown company and 400s a bad id", async () => {
    const { GET } = await import("../app/api/companies/[id]/profile/route");
    expect((await GET(new Request("http://x"), params(999))).status).toBe(404);
    expect((await GET(new Request("http://x"), params("abc"))).status).toBe(400);
  });
});

describe("GET /api/contacts/[id]/profile", () => {
  it("says when the contact is the principal the site names", async () => {
    const { GET } = await import("../app/api/contacts/[id]/profile/route");
    const body = await (await GET(new Request("http://x"), params(5))).json();
    expect(body.owner).toMatchObject({ isPrincipal: true, principal: null });
    expect(body.owner.siteMatch.name).toBe("Walter Brandt");
  });
  it("names the site's principal when the contact is someone else", async () => {
    const { GET } = await import("../app/api/contacts/[id]/profile/route");
    const body = await (await GET(new Request("http://x"), params(6))).json();
    expect(body.owner.isPrincipal).toBe(false);
    expect(body.owner.principal.name.value).toBe("Walter Brandt");
  });
  it("404s an unknown contact", async () => {
    const { GET } = await import("../app/api/contacts/[id]/profile/route");
    expect((await GET(new Request("http://x"), params(999))).status).toBe(404);
  });
});

describe("POST /api/companies/[id]/profile/refresh", () => {
  it("is owner-only: a member or principal gets 403 and nothing runs", async () => {
    const { POST } = await import("../app/api/companies/[id]/profile/refresh/route");
    for (const role of ["member", "principal"] as const) {
      session.role = role;
      expect((await POST(new Request("http://x", { method: "POST" }), params(10))).status).toBe(403);
    }
    expect(runner.impl).not.toHaveBeenCalled();
  });

  it("runs the enrichment for that one company and writes an audit row", async () => {
    runner.impl = vi.fn(async () => ({ ok: true, writes: { insert: 3, same: 9 }, fields: ["summary"], pages: 4, registry: "name+city" }));
    const { POST } = await import("../app/api/companies/[id]/profile/refresh/route");
    const res = await POST(new Request("http://x", { method: "POST" }), params(10));
    expect(res.status).toBe(200);
    expect(runner.impl).toHaveBeenCalledWith(10);
    const row = dbModule.db().prepare("SELECT action, entity_id, detail_json FROM audit_log WHERE action = 'profile.refresh'").get() as {
      action: string;
      entity_id: number;
      detail_json: string;
    };
    expect(row.entity_id).toBe(10);
    expect(JSON.parse(row.detail_json)).toMatchObject({ ok: true, writes: { insert: 3 } });
  });

  it("reports a missing Python as 503 and still audits the attempt", async () => {
    runner.impl = vi.fn(async () => ({ ok: false, error: "Profile refresh needs Python on the server", unavailable: true }));
    const { POST } = await import("../app/api/companies/[id]/profile/refresh/route");
    const res = await POST(new Request("http://x", { method: "POST" }), params(10));
    expect(res.status).toBe(503);
    const n = dbModule.db().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile.refresh'").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("404s an unknown company without running anything", async () => {
    const { POST } = await import("../app/api/companies/[id]/profile/refresh/route");
    expect((await POST(new Request("http://x", { method: "POST" }), params(999))).status).toBe(404);
    expect(runner.impl).not.toHaveBeenCalled();
  });
});
