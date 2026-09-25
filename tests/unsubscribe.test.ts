import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpDir: string;
let dbModule: typeof import("../app/lib/db");
let routeModule: typeof import("../app/api/unsubscribe/[token]/route");

async function freshDb() {
  tmpDir = mkdtempSync(path.join(tmpdir(), "harness-db-"));
  process.env.HARNESS_DB_PATH = path.join(tmpDir, "test.db");
  process.env.APP_BASE_URL = "https://harness.example.com";
  vi.resetModules();
  dbModule = await import("../app/lib/db");
  routeModule = await import("../app/api/unsubscribe/[token]/route");
  dbModule.db();
  templateId = null;
}

function seedContact(email: string) {
  const info = dbModule
    .db()
    .prepare(`INSERT INTO contacts (first_name, last_name, email) VALUES ('Dana','Owner',?)`)
    .run(email);
  return Number(info.lastInsertRowid);
}

let templateId: number | null = null;
function seedTemplateOnce(): number {
  if (templateId !== null) return templateId;
  const info = dbModule
    .db()
    .prepare(
      `INSERT INTO templates (name, segment_id, subject, body, content_hash, status) VALUES ('T', 'owners', 'S', 'B', 'h', 'draft')`
    )
    .run();
  templateId = Number(info.lastInsertRowid);
  return templateId;
}

function seedMessage(contactId: number, token: string, status = "queued") {
  const info = dbModule
    .db()
    .prepare(
      `INSERT INTO outbound_messages
        (contact_id, template_id, template_hash, rendered_subject, rendered_body, status, unsubscribe_token)
       VALUES (?, ?, 'hash', 'Subject', 'Body', ?, ?)`
    )
    .run(contactId, seedTemplateOnce(), status, token);
  return Number(info.lastInsertRowid);
}

function postTo(token: string, body?: string, contentType = "application/x-www-form-urlencoded") {
  const req = new Request(`https://harness.example.com/api/unsubscribe/${token}`, {
    method: "POST",
    headers: body ? { "content-type": contentType } : undefined,
    body,
  });
  return routeModule.POST(req, { params: Promise.resolve({ token }) });
}

describe("POST /api/unsubscribe/[token]", () => {
  beforeEach(async () => {
    await freshDb();
  });

  afterEach(() => {
    delete process.env.HARNESS_DB_PATH;
    delete process.env.APP_BASE_URL;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("suppresses the contact, sets do_not_contact and unsubscribed_at, and audits", async () => {
    const contactId = seedContact("dana@example.com");
    seedMessage(contactId, "tok1");
    const res = await postTo("tok1");

    expect(res.status).toBe(303);

    const contact = dbModule
      .db()
      .prepare(`SELECT do_not_contact, unsubscribed_at FROM contacts WHERE id = ?`)
      .get(contactId) as { do_not_contact: number; unsubscribed_at: string | null };
    expect(contact.do_not_contact).toBe(1);
    expect(contact.unsubscribed_at).not.toBeNull();

    const suppressed = dbModule.db().prepare(`SELECT email FROM suppression WHERE email = ?`).get("dana@example.com");
    expect(suppressed).toBeDefined();

    const auditRow = dbModule
      .db()
      .prepare(`SELECT action, actor_label, entity FROM audit_log WHERE action = 'contact.unsubscribe' ORDER BY id DESC LIMIT 1`)
      .get() as { action: string; actor_label: string; entity: string } | undefined;
    expect(auditRow).toBeDefined();
    expect(auditRow?.actor_label).toBe("recipient");
    expect(auditRow?.entity).toBe("contact");
  });

  it("cancels every queued or held message for that contact", async () => {
    const contactId = seedContact("dana2@example.com");
    seedMessage(contactId, "tokA", "queued");
    const heldId = seedMessage(contactId, "tokB", "held");
    seedMessage(contactId, "tokA2", "sent"); // sent messages are untouched

    await postTo("tokA");

    const messages = dbModule
      .db()
      .prepare(`SELECT unsubscribe_token, status FROM outbound_messages WHERE contact_id = ?`)
      .all(contactId) as { unsubscribe_token: string; status: string }[];
    const byToken = Object.fromEntries(messages.map((m) => [m.unsubscribe_token, m.status]));
    expect(byToken["tokA"]).toBe("cancelled");
    expect(byToken["tokB"]).toBe("cancelled");
    expect(byToken["tokA2"]).toBe("sent");
    expect(heldId).toBeGreaterThan(0);
  });

  it("is idempotent: calling it twice does not error and leaves the same suppressed state", async () => {
    const contactId = seedContact("dana3@example.com");
    seedMessage(contactId, "tokC", "queued");

    const first = await postTo("tokC");
    const second = await postTo("tokC");

    expect(first.status).toBe(303);
    expect(second.status).toBe(303);

    const suppressedRows = dbModule
      .db()
      .prepare(`SELECT COUNT(*) as n FROM suppression WHERE email = ?`)
      .get("dana3@example.com") as { n: number };
    expect(suppressedRows.n).toBe(1);
  });

  it("leaks nothing on an unknown token: same response shape, no error, no rows written", async () => {
    const before = dbModule.db().prepare(`SELECT COUNT(*) as n FROM suppression`).get() as { n: number };
    const res = await postTo("does-not-exist");
    expect(res.status).toBe(303);
    const after = dbModule.db().prepare(`SELECT COUNT(*) as n FROM suppression`).get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("handles an RFC 8058 one-click POST body with a plain 200 and no redirect", async () => {
    const contactId = seedContact("dana4@example.com");
    seedMessage(contactId, "tokD", "queued");
    const res = await postTo("tokD", "List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    const contact = dbModule.db().prepare(`SELECT do_not_contact FROM contacts WHERE id = ?`).get(contactId) as {
      do_not_contact: number;
    };
    expect(contact.do_not_contact).toBe(1);
  });

  it("rate limits at 30 requests per 10 minutes per IP", async () => {
    const ip = "203.0.113.9";
    const req = (n: number) =>
      new Request(`https://harness.example.com/api/unsubscribe/tokX${n}`, {
        method: "POST",
        headers: { "x-forwarded-for": ip },
      });
    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const res = await routeModule.POST(req(i), { params: Promise.resolve({ token: `tokX${i}` }) });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
