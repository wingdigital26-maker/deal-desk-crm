// Exercises the actual DELETE handlers in app/api/deals/[id]/route.ts and
// app/api/contacts/[id]/route.ts against a real temp database: owner-only
// enforcement, the audit_log row, and the FINRA 17a-4 block that keeps a
// contact with a sent message from being deleted.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SECRET = "d".repeat(32);
let currentToken: string | undefined;

// The route handlers call requireUser() -> currentUser(), which reads the
// session cookie via next/headers. Mock that one call site so each test can
// act as a specific signed-in user without a real HTTP request.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "harness_session" ? { value: currentToken } : undefined),
  }),
}));

let dbModule: typeof import("../app/lib/db");
let sessionModule: typeof import("../app/lib/session");
let dealsRoute: typeof import("../app/api/deals/[id]/route");
let contactsRoute: typeof import("../app/api/contacts/[id]/route");

function freshDb() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "harness-delete-"));
  process.env.HARNESS_DB_PATH = path.join(tmpDir, "test.db");
}

beforeEach(async () => {
  freshDb();
  process.env.SESSION_SECRET = SECRET;
  currentToken = undefined;
  vi.resetModules();
  dbModule = await import("../app/lib/db");
  sessionModule = await import("../app/lib/session");
  dealsRoute = await import("../app/api/deals/[id]/route");
  contactsRoute = await import("../app/api/contacts/[id]/route");
  dbModule.db(); // create schema
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.HARNESS_DB_PATH;
  vi.restoreAllMocks();
});

function insertUser(role: "owner" | "principal" | "member") {
  const info = dbModule
    .db()
    .prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)")
    .run(`${role}-${Math.random()}@example.com`, `Test ${role}`, role, "scrypt$aa$bb");
  return Number(info.lastInsertRowid);
}

async function signInAs(userId: number, role: "owner" | "principal" | "member") {
  const row = dbModule.db().prepare("SELECT email, name FROM users WHERE id = ?").get(userId) as {
    email: string;
    name: string;
  };
  currentToken = (await sessionModule.signSession({ id: userId, email: row.email, name: row.name, role })) ?? undefined;
}

function insertCompany() {
  const info = dbModule.db().prepare("INSERT INTO companies (name) VALUES (?)").run(`Acme ${Math.random()}`);
  return Number(info.lastInsertRowid);
}

function insertDeal(companyId: number) {
  const info = dbModule
    .db()
    .prepare("INSERT INTO deals (company_id, title) VALUES (?, ?)")
    .run(companyId, "Northwind Products: sell-side");
  return Number(info.lastInsertRowid);
}

function insertContact(email: string) {
  const info = dbModule
    .db()
    .prepare("INSERT INTO contacts (first_name, last_name, email) VALUES (?, ?, ?)")
    .run("Jane", "Doe", email);
  return Number(info.lastInsertRowid);
}

function ctx(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

describe("DELETE /api/deals/[id]", () => {
  it("blocks a non-owner (member) with 403 and does not delete the row", async () => {
    const memberId = insertUser("member");
    await signInAs(memberId, "member");
    const companyId = insertCompany();
    const dealId = insertDeal(companyId);

    const res = await dealsRoute.DELETE(new Request("http://x"), ctx(dealId));
    expect(res.status).toBe(403);

    const stillThere = dbModule.db().prepare("SELECT id FROM deals WHERE id = ?").get(dealId);
    expect(stillThere).toBeTruthy();
  });

  it("blocks a principal with 403", async () => {
    const principalId = insertUser("principal");
    await signInAs(principalId, "principal");
    const dealId = insertDeal(insertCompany());

    const res = await dealsRoute.DELETE(new Request("http://x"), ctx(dealId));
    expect(res.status).toBe(403);
  });

  it("lets an owner delete a deal and writes an audit row", async () => {
    const ownerId = insertUser("owner");
    await signInAs(ownerId, "owner");
    const dealId = insertDeal(insertCompany());

    const res = await dealsRoute.DELETE(new Request("http://x"), ctx(dealId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const gone = dbModule.db().prepare("SELECT id FROM deals WHERE id = ?").get(dealId);
    expect(gone).toBeUndefined();

    const audit = dbModule
      .db()
      .prepare("SELECT * FROM audit_log WHERE action = 'deal.delete' AND entity_id = ?")
      .get(dealId) as { actor_user_id: number } | undefined;
    expect(audit).toBeTruthy();
    expect(audit?.actor_user_id).toBe(ownerId);
  });

  it("404s for a deal that does not exist", async () => {
    const ownerId = insertUser("owner");
    await signInAs(ownerId, "owner");
    const res = await dealsRoute.DELETE(new Request("http://x"), ctx(999999));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/contacts/[id]", () => {
  it("blocks a non-owner (member) with 403 and does not delete the row", async () => {
    const memberId = insertUser("member");
    await signInAs(memberId, "member");
    const contactId = insertContact("jane@example.com");

    const res = await contactsRoute.DELETE(new Request("http://x"), ctx(contactId));
    expect(res.status).toBe(403);

    const stillThere = dbModule.db().prepare("SELECT id FROM contacts WHERE id = ?").get(contactId);
    expect(stillThere).toBeTruthy();
  });

  it("lets an owner delete a contact with no sent messages and writes an audit row", async () => {
    const ownerId = insertUser("owner");
    await signInAs(ownerId, "owner");
    const contactId = insertContact("jane@example.com");

    const res = await contactsRoute.DELETE(new Request("http://x"), ctx(contactId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const gone = dbModule.db().prepare("SELECT id FROM contacts WHERE id = ?").get(contactId);
    expect(gone).toBeUndefined();

    const audit = dbModule
      .db()
      .prepare("SELECT * FROM audit_log WHERE action = 'contact.delete' AND entity_id = ?")
      .get(contactId) as { actor_user_id: number } | undefined;
    expect(audit).toBeTruthy();
    expect(audit?.actor_user_id).toBe(ownerId);
  });

  it("blocks deleting a contact that has a SENT message on record (FINRA 17a-4)", async () => {
    const ownerId = insertUser("owner");
    await signInAs(ownerId, "owner");
    const contactId = insertContact("jane@example.com");

    const templateInfo = dbModule
      .db()
      .prepare(
        "INSERT INTO templates (name, segment_id, subject, body, content_hash, status) VALUES (?, 'owners', 'Hi', 'Body', 'hash1', 'approved')"
      )
      .run("Test template");
    const templateId = Number(templateInfo.lastInsertRowid);
    dbModule
      .db()
      .prepare(
        `INSERT INTO outbound_messages (contact_id, template_id, template_hash, rendered_subject, rendered_body, status, sent_at)
         VALUES (?, ?, 'hash1', 'Hi', 'Body', 'sent', datetime('now'))`
      )
      .run(contactId, templateId);

    const res = await contactsRoute.DELETE(new Request("http://x"), ctx(contactId));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/sent emails on record/i);

    const stillThere = dbModule.db().prepare("SELECT id FROM contacts WHERE id = ?").get(contactId);
    expect(stillThere).toBeTruthy();
  });

  it("allows deleting a contact whose messages are only queued or held, not sent", async () => {
    const ownerId = insertUser("owner");
    await signInAs(ownerId, "owner");
    const contactId = insertContact("jane@example.com");

    const templateInfo = dbModule
      .db()
      .prepare(
        "INSERT INTO templates (name, segment_id, subject, body, content_hash, status) VALUES (?, 'owners', 'Hi', 'Body', 'hash1', 'approved')"
      )
      .run("Test template");
    const templateId = Number(templateInfo.lastInsertRowid);
    dbModule
      .db()
      .prepare(
        `INSERT INTO outbound_messages (contact_id, template_id, template_hash, rendered_subject, rendered_body, status)
         VALUES (?, ?, 'hash1', 'Hi', 'Body', 'queued')`
      )
      .run(contactId, templateId);

    const res = await contactsRoute.DELETE(new Request("http://x"), ctx(contactId));
    expect(res.status).toBe(200);
  });

  it("404s for a contact that does not exist", async () => {
    const ownerId = insertUser("owner");
    await signInAs(ownerId, "owner");
    const res = await contactsRoute.DELETE(new Request("http://x"), ctx(999999));
    expect(res.status).toBe(404);
  });
});
