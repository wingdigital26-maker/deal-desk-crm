import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// No test here reaches the network; ingestReply is pure db + local logic.
vi.stubGlobal(
  "fetch",
  vi.fn(() => {
    throw new Error("network I/O attempted in replies-ingest test");
  })
);

let tmpDir: string;
let dbModule: typeof import("../app/lib/db");
let repliesModule: typeof import("../app/lib/replies/sync");

async function freshDb() {
  tmpDir = mkdtempSync(path.join(tmpdir(), "harness-db-"));
  process.env.HARNESS_DB_PATH = path.join(tmpDir, "test.db");
  vi.resetModules();
  dbModule = await import("../app/lib/db");
  repliesModule = await import("../app/lib/replies/sync");
  dbModule.db();
  templateId = null;
}

function seedContact(overrides: Partial<{ email: string; company_id: number | null }> = {}) {
  const info = dbModule
    .db()
    .prepare(`INSERT INTO contacts (first_name, last_name, email, company_id) VALUES ('Dana', 'Owner', ?, ?)`)
    .run(overrides.email ?? "dana@example.com", overrides.company_id ?? null);
  return Number(info.lastInsertRowid);
}

let templateId: number | null = null;
function seedTemplateId(): number {
  if (templateId !== null) return templateId;
  const info = dbModule
    .db()
    .prepare(
      `INSERT INTO templates (name, segment_id, subject, body, content_hash, status) VALUES ('T', 'owners', 'S', 'B', 'x', 'approved')`
    )
    .run();
  templateId = Number(info.lastInsertRowid);
  return templateId;
}

function seedSentMessage(contactId: number) {
  const info = dbModule
    .db()
    .prepare(
      `INSERT INTO outbound_messages (contact_id, template_id, template_hash, rendered_subject, rendered_body, status, sent_at)
       VALUES (?, ?, 'x', 'Subject', 'Body', 'sent', datetime('now'))`
    )
    .run(contactId, seedTemplateId());
  return Number(info.lastInsertRowid);
}

function seedQueuedMessage(contactId: number, status: "queued" | "held" = "queued") {
  const info = dbModule
    .db()
    .prepare(
      `INSERT INTO outbound_messages (contact_id, template_id, template_hash, rendered_subject, rendered_body, status)
       VALUES (?, ?, 'x', 'Subject', 'Body', ?)`
    )
    .run(contactId, seedTemplateId(), status);
  return Number(info.lastInsertRowid);
}

describe("ingestReply", () => {
  beforeEach(freshDb);
  afterEach(() => {
    delete process.env.HARNESS_DB_PATH;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("is idempotent on provider_id: a second call with the same id inserts nothing and runs no effects again", () => {
    const contactId = seedContact();
    const first = repliesModule.ingestReply({
      providerId: "p1",
      fromEmail: "dana@example.com",
      subject: "Re: intro",
      snippet: "sounds good",
      receivedAt: new Date().toISOString(),
    });
    expect(first.inserted).toBe(true);

    const queuedBefore = seedQueuedMessage(contactId);
    const second = repliesModule.ingestReply({
      providerId: "p1",
      fromEmail: "dana@example.com",
      subject: "Re: intro",
      snippet: "sounds good",
      receivedAt: new Date().toISOString(),
    });
    expect(second.inserted).toBe(false);

    const count = dbModule.db().prepare(`SELECT COUNT(*) as n FROM inbound_replies WHERE provider_id = 'p1'`).get() as { n: number };
    expect(count.n).toBe(1);

    // The message queued after the first ingest should be untouched by the
    // no-op second call.
    const msg = dbModule.db().prepare(`SELECT status FROM outbound_messages WHERE id = ?`).get(queuedBefore) as { status: string };
    expect(msg.status).toBe("queued");
  });

  it("reply: sets replied_at on the matched sent message, cancels other queued/held messages, logs an activity and creates a task", () => {
    const contactId = seedContact();
    const sentId = seedSentMessage(contactId);
    const queuedId = seedQueuedMessage(contactId, "queued");
    const heldId = seedQueuedMessage(contactId, "held");

    const result = repliesModule.ingestReply({
      providerId: "reply-1",
      fromEmail: "dana@example.com",
      subject: "Re: intro",
      snippet: "Tell me more",
      receivedAt: new Date().toISOString(),
      messageId: sentId,
    });
    expect(result.inserted).toBe(true);
    expect(result.kind).toBe("reply");

    const sent = dbModule.db().prepare(`SELECT replied_at FROM outbound_messages WHERE id = ?`).get(sentId) as { replied_at: string | null };
    expect(sent.replied_at).toBeTruthy();

    const queued = dbModule.db().prepare(`SELECT status FROM outbound_messages WHERE id = ?`).get(queuedId) as { status: string };
    const held = dbModule.db().prepare(`SELECT status FROM outbound_messages WHERE id = ?`).get(heldId) as { status: string };
    expect(queued.status).toBe("cancelled");
    expect(held.status).toBe("cancelled");

    const activity = dbModule
      .db()
      .prepare(`SELECT kind, contact_id FROM activities WHERE contact_id = ? AND kind = 'email-in'`)
      .get(contactId) as { kind: string; contact_id: number } | undefined;
    expect(activity).toBeTruthy();

    const task = dbModule.db().prepare(`SELECT title, due FROM tasks WHERE contact_id = ?`).get(contactId) as { title: string; due: string } | undefined;
    expect(task).toBeTruthy();
    expect(task!.title).toMatch(/Reply to Dana Owner/);
  });

  it("reply: matches a contact by from_email when no messageId is given", () => {
    const contactId = seedContact({ email: "byemail@example.com" });
    const sentId = seedSentMessage(contactId);
    const result = repliesModule.ingestReply({
      providerId: "reply-2",
      fromEmail: "ByEmail@Example.com",
      subject: "Re: intro",
      snippet: "sounds good",
      receivedAt: new Date().toISOString(),
    });
    expect(result.contactId).toBe(contactId);
    const sent = dbModule.db().prepare(`SELECT replied_at FROM outbound_messages WHERE id = ?`).get(sentId) as { replied_at: string | null };
    expect(sent.replied_at).toBeTruthy();
  });

  it("bounce: sets email_status to no-mx and cancels the queue", () => {
    const contactId = seedContact();
    const queuedId = seedQueuedMessage(contactId);
    const result = repliesModule.ingestReply({
      providerId: "bounce-1",
      fromEmail: "mailer-daemon@example.com",
      subject: "Delivery Status Notification (Failure)",
      snippet: "550 no such user",
      receivedAt: new Date().toISOString(),
      messageId: undefined,
    });
    expect(result.kind).toBe("bounce");

    // Bounce comes from mailer-daemon, not the contact's address, so it will
    // not auto-match a contact; simulate the provider telling us which
    // message bounced by re-ingesting with an explicit messageId.
    const explicit = repliesModule.ingestReply({
      providerId: "bounce-2",
      fromEmail: "mailer-daemon@example.com",
      subject: "Delivery Status Notification (Failure)",
      snippet: "550 no such user",
      receivedAt: new Date().toISOString(),
      messageId: queuedId,
    });
    expect(explicit.contactId).toBe(contactId);
    const contact = dbModule.db().prepare(`SELECT email_status FROM contacts WHERE id = ?`).get(contactId) as { email_status: string };
    expect(contact.email_status).toBe("no-mx");
    const queued = dbModule.db().prepare(`SELECT status FROM outbound_messages WHERE id = ?`).get(queuedId) as { status: string };
    expect(queued.status).toBe("cancelled");
  });

  it("unsubscribe: adds to suppression, sets do_not_contact, and cancels the queue", () => {
    const contactId = seedContact({ email: "stop@example.com" });
    const queuedId = seedQueuedMessage(contactId);
    const result = repliesModule.ingestReply({
      providerId: "unsub-1",
      fromEmail: "stop@example.com",
      subject: "Re: intro",
      snippet: "please unsubscribe me",
      receivedAt: new Date().toISOString(),
    });
    expect(result.kind).toBe("unsubscribe");

    const suppressed = dbModule.db().prepare(`SELECT email FROM suppression WHERE email = 'stop@example.com'`).get();
    expect(suppressed).toBeTruthy();
    const contact = dbModule.db().prepare(`SELECT do_not_contact FROM contacts WHERE id = ?`).get(contactId) as { do_not_contact: number };
    expect(contact.do_not_contact).toBe(1);
    const queued = dbModule.db().prepare(`SELECT status FROM outbound_messages WHERE id = ?`).get(queuedId) as { status: string };
    expect(queued.status).toBe("cancelled");
  });

  it("auto-reply: is recorded with no side effects on outbound_messages or contacts", () => {
    const contactId = seedContact();
    const queuedId = seedQueuedMessage(contactId);
    const result = repliesModule.ingestReply({
      providerId: "auto-1",
      fromEmail: "dana@example.com",
      subject: "Out of Office",
      snippet: "I am out until Monday",
      receivedAt: new Date().toISOString(),
    });
    expect(result.kind).toBe("auto-reply");
    const queued = dbModule.db().prepare(`SELECT status FROM outbound_messages WHERE id = ?`).get(queuedId) as { status: string };
    expect(queued.status).toBe("queued");
  });
});
