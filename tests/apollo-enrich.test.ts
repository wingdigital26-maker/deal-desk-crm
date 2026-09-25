import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Every test in this file stubs fetch to throw, so nothing here can reach
// the real Apollo API even if a mock is wired wrong.
vi.stubGlobal(
  "fetch",
  vi.fn(() => {
    throw new Error("network I/O attempted in apollo-enrich test");
  })
);

const mockUser = { id: 1, email: "owner@example.com", name: "Owner", role: "owner" as const };

vi.mock("../app/lib/session", () => ({
  requireUser: vi.fn(async () => mockUser),
}));

type EnrichedPerson = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  linkedinUrl: string | null;
  organizationName: string | null;
  organizationDomain: string | null;
  city: string | null;
  state: string | null;
  raw: unknown;
} | null;

const apolloState: { configured: boolean; enrichImpl: () => Promise<EnrichedPerson> } = {
  configured: false,
  enrichImpl: async () => null,
};

vi.mock("../app/lib/apollo/client", () => ({
  isConfigured: () => apolloState.configured,
  enrichPerson: (..._args: unknown[]) => apolloState.enrichImpl(),
  ApolloAuthError: class ApolloAuthError extends Error {},
  ApolloRateLimited: class ApolloRateLimited extends Error {},
  ApolloRequestError: class ApolloRequestError extends Error {},
  ApolloNotConfigured: class ApolloNotConfigured extends Error {},
}));

let tmpDir: string;
let dbModule: typeof import("../app/lib/db");

async function freshDb() {
  tmpDir = mkdtempSync(path.join(tmpdir(), "harness-db-"));
  process.env.HARNESS_DB_PATH = path.join(tmpDir, "test.db");
  vi.resetModules();
  dbModule = await import("../app/lib/db");
  dbModule.db();
}

function seedContact(overrides: Partial<{ apollo_id: string | null; email: string | null; last_name: string; title: string | null; linkedin_url: string | null; company_id: number | null; do_not_contact: number }> = {}) {
  const info = dbModule
    .db()
    .prepare(
      `INSERT INTO contacts (first_name, last_name, title, email, apollo_id, linkedin_url, company_id, do_not_contact)
       VALUES ('Dana', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      overrides.last_name ?? "Owner",
      overrides.title ?? null,
      overrides.email ?? null,
      overrides.apollo_id === undefined ? "apollo-1" : overrides.apollo_id,
      overrides.linkedin_url ?? null,
      overrides.company_id ?? null,
      overrides.do_not_contact ?? 0
    );
  return Number(info.lastInsertRowid);
}

function req(body: unknown) {
  return new Request("http://localhost/api/apollo/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/apollo/enrich", () => {
  beforeEach(async () => {
    await freshDb();
    apolloState.configured = false;
    apolloState.enrichImpl = async () => null;
  });

  afterEach(() => {
    delete process.env.HARNESS_DB_PATH;
    delete process.env.APOLLO_DAILY_CREDIT_CAP;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("refuses without confirmSpend: true", async () => {
    const { POST } = await import("../app/api/apollo/enrich/route");
    const res = await POST(req({ contactIds: [1] }));
    expect(res.status).toBe(400);
  });

  it("refuses confirmSpend that is truthy but not === true", async () => {
    const { POST } = await import("../app/api/apollo/enrich/route");
    const res = await POST(req({ contactIds: [1], confirmSpend: "true" }));
    expect(res.status).toBe(400);
  });

  it("refuses an empty contactIds array", async () => {
    const { POST } = await import("../app/api/apollo/enrich/route");
    const res = await POST(req({ contactIds: [], confirmSpend: true }));
    expect(res.status).toBe(400);
  });

  it("refuses more than 50 ids in one call", async () => {
    const { POST } = await import("../app/api/apollo/enrich/route");
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    const res = await POST(req({ contactIds: ids, confirmSpend: true }));
    expect(res.status).toBe(400);
  });

  it("refuses with 503 when Apollo is not configured", async () => {
    apolloState.configured = false;
    const id = seedContact();
    const { POST } = await import("../app/api/apollo/enrich/route");
    const res = await POST(req({ contactIds: [id], confirmSpend: true }));
    expect(res.status).toBe(503);
  });

  it("reports a contact with no apollo_id as a per-contact failure, not a call", async () => {
    apolloState.configured = true;
    let called = false;
    apolloState.enrichImpl = async () => {
      called = true;
      return null;
    };
    const id = seedContact({ apollo_id: null });
    const { POST } = await import("../app/api/apollo/enrich/route");
    const res = await POST(req({ contactIds: [id], confirmSpend: true }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.results[0].ok).toBe(false);
    expect(called).toBe(false);
    expect(data.creditsUsed).toBe(0);
  });

  it("reports a contact that already has an email as a per-contact failure, not a call", async () => {
    apolloState.configured = true;
    let called = false;
    apolloState.enrichImpl = async () => {
      called = true;
      return null;
    };
    const id = seedContact({ email: "already@example.com" });
    const { POST } = await import("../app/api/apollo/enrich/route");
    const res = await POST(req({ contactIds: [id], confirmSpend: true }));
    const data = await res.json();
    expect(data.results[0].ok).toBe(false);
    expect(called).toBe(false);
  });

  it("enriches an eligible contact and stores the lowercased email", async () => {
    apolloState.configured = true;
    apolloState.enrichImpl = async () => ({
      id: "apollo-1",
      firstName: "Dana",
      lastName: "Owner",
      name: "Dana Owner",
      title: "CEO",
      email: "Found@Example.com",
      emailStatus: "verified",
      linkedinUrl: "https://linkedin.com/in/dana",
      organizationName: "Acme",
      organizationDomain: "acme.com",
      city: null,
      state: null,
      raw: null,
    });
    const id = seedContact();
    const { POST } = await import("../app/api/apollo/enrich/route");
    const res = await POST(req({ contactIds: [id], confirmSpend: true }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.results[0]).toMatchObject({ contactId: id, ok: true, email: "found@example.com" });
    expect(data.creditsUsed).toBe(1);

    const row = dbModule.db().prepare(`SELECT email, email_status, title, linkedin_url, enriched_at FROM contacts WHERE id = ?`).get(id) as {
      email: string;
      email_status: string;
      title: string;
      linkedin_url: string;
      enriched_at: string | null;
    };
    expect(row.email).toBe("found@example.com");
    expect(row.email_status).toBe("unknown");
    expect(row.title).toBe("CEO");
    expect(row.linkedin_url).toBe("https://linkedin.com/in/dana");
    expect(row.enriched_at).toBeTruthy();
  });

  it("fills the full last name only when the stored last name is masked", async () => {
    apolloState.configured = true;
    apolloState.enrichImpl = async () => ({
      id: "apollo-1",
      firstName: "Dana",
      lastName: "Ownerson",
      name: null,
      title: null,
      email: "dana@example.com",
      emailStatus: null,
      linkedinUrl: null,
      organizationName: null,
      organizationDomain: null,
      city: null,
      state: null,
      raw: null,
    });
    const id = seedContact({ last_name: "O****" });
    const { POST } = await import("../app/api/apollo/enrich/route");
    await POST(req({ contactIds: [id], confirmSpend: true }));
    const row = dbModule.db().prepare(`SELECT last_name FROM contacts WHERE id = ?`).get(id) as { last_name: string };
    expect(row.last_name).toBe("Ownerson");
  });

  it("does not overwrite the last name when it is not masked", async () => {
    apolloState.configured = true;
    apolloState.enrichImpl = async () => ({
      id: "apollo-1",
      firstName: "Dana",
      lastName: "SomeoneElse",
      name: null,
      title: null,
      email: "dana@example.com",
      emailStatus: null,
      linkedinUrl: null,
      organizationName: null,
      organizationDomain: null,
      city: null,
      state: null,
      raw: null,
    });
    const id = seedContact({ last_name: "Owner" });
    const { POST } = await import("../app/api/apollo/enrich/route");
    await POST(req({ contactIds: [id], confirmSpend: true }));
    const row = dbModule.db().prepare(`SELECT last_name FROM contacts WHERE id = ?`).get(id) as { last_name: string };
    expect(row.last_name).toBe("Owner");
  });

  it("reports a conflict and does not overwrite when the returned email belongs to another contact", async () => {
    apolloState.configured = true;
    apolloState.enrichImpl = async () => ({
      id: "apollo-1",
      firstName: null,
      lastName: null,
      name: null,
      title: null,
      email: "taken@example.com",
      emailStatus: null,
      linkedinUrl: null,
      organizationName: null,
      organizationDomain: null,
      city: null,
      state: null,
      raw: null,
    });
    seedContact({ email: "taken@example.com", apollo_id: "other" });
    const id = seedContact();
    const { POST } = await import("../app/api/apollo/enrich/route");
    const res = await POST(req({ contactIds: [id], confirmSpend: true }));
    const data = await res.json();
    expect(data.results[0].ok).toBe(false);
    expect(data.results[0].error).toMatch(/already belongs/i);
    const row = dbModule.db().prepare(`SELECT email FROM contacts WHERE id = ?`).get(id) as { email: string | null };
    expect(row.email).toBeNull();
  });

  it("marks do_not_contact when the returned email is on the suppression list, and never unsets it", async () => {
    apolloState.configured = true;
    apolloState.enrichImpl = async () => ({
      id: "apollo-1",
      firstName: null,
      lastName: null,
      name: null,
      title: null,
      email: "bad@example.com",
      emailStatus: null,
      linkedinUrl: null,
      organizationName: null,
      organizationDomain: null,
      city: null,
      state: null,
      raw: null,
    });
    dbModule.db().prepare(`INSERT INTO suppression (email, reason) VALUES ('bad@example.com', 'bounced')`).run();
    const id = seedContact();
    const { POST } = await import("../app/api/apollo/enrich/route");
    await POST(req({ contactIds: [id], confirmSpend: true }));
    const row = dbModule.db().prepare(`SELECT do_not_contact FROM contacts WHERE id = ?`).get(id) as { do_not_contact: number };
    expect(row.do_not_contact).toBe(1);
  });

  it("fills a company's empty domain from the enriched organization domain", async () => {
    apolloState.configured = true;
    apolloState.enrichImpl = async () => ({
      id: "apollo-1",
      firstName: null,
      lastName: null,
      name: null,
      title: null,
      email: "dana@example.com",
      emailStatus: null,
      linkedinUrl: null,
      organizationName: "Acme",
      organizationDomain: "Acme.com",
      city: null,
      state: null,
      raw: null,
    });
    const companyId = Number(
      dbModule.db().prepare(`INSERT INTO companies (name) VALUES ('Acme')`).run().lastInsertRowid
    );
    const id = seedContact({ company_id: companyId });
    const { POST } = await import("../app/api/apollo/enrich/route");
    await POST(req({ contactIds: [id], confirmSpend: true }));
    const row = dbModule.db().prepare(`SELECT domain FROM companies WHERE id = ?`).get(companyId) as { domain: string | null };
    expect(row.domain).toBe("acme.com");
  });

  it("refuses when the daily credit cap would be exceeded, before calling Apollo", async () => {
    process.env.APOLLO_DAILY_CREDIT_CAP = "1";
    apolloState.configured = true;
    let calls = 0;
    apolloState.enrichImpl = async () => {
      calls += 1;
      return null;
    };
    const a = seedContact({ apollo_id: "a" });
    const b = seedContact({ apollo_id: "b" });
    const { POST } = await import("../app/api/apollo/enrich/route");
    const res = await POST(req({ contactIds: [a, b], confirmSpend: true }));
    expect(res.status).toBe(429);
    expect(calls).toBe(0);
  });

  it("writes one audit_log row per call with counts and credits, never the API key", async () => {
    apolloState.configured = true;
    apolloState.enrichImpl = async () => ({
      id: "apollo-1",
      firstName: null,
      lastName: null,
      name: null,
      title: null,
      email: "dana@example.com",
      emailStatus: null,
      linkedinUrl: null,
      organizationName: null,
      organizationDomain: null,
      city: null,
      state: null,
      raw: null,
    });
    const id = seedContact();
    const { POST } = await import("../app/api/apollo/enrich/route");
    await POST(req({ contactIds: [id], confirmSpend: true }));
    const rows = dbModule.db().prepare(`SELECT detail_json FROM audit_log WHERE action = 'apollo.enrich'`).all() as { detail_json: string }[];
    expect(rows.length).toBe(1);
    const detail = JSON.parse(rows[0].detail_json);
    expect(detail.creditsUsed).toBe(1);
    expect(detail.succeeded).toBe(1);
    expect(JSON.stringify(detail)).not.toMatch(/APOLLO_API_KEY|api[_-]?key/i);
  });
});
