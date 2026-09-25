import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentHash, renderTemplate } from "../app/lib/compliance";

// A Monday so mailbox warmup caps (Mon-Fri send days) are non-zero and stable
// regardless of what day the suite actually runs on.
const SEND_DAY = new Date(2026, 8, 21); // 2026-09-21, a Monday

let tmpDir: string;
let dbModule: typeof import("../app/lib/db");
let sendGateModule: typeof import("../app/lib/outbound/sendGate");

async function freshDb() {
  tmpDir = mkdtempSync(path.join(tmpdir(), "harness-db-"));
  process.env.HARNESS_DB_PATH = path.join(tmpDir, "test.db");
  process.env.APP_BASE_URL = "https://harness.example.com";
  vi.resetModules();
  dbModule = await import("../app/lib/db");
  sendGateModule = await import("../app/lib/outbound/sendGate");
  // Touch db() once to create schema.
  dbModule.db();
}

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return `test-token-${tokenCounter}`;
}

function seedApprovedTemplate(overrides: Partial<{ subject: string; body: string; fields: string[] }> = {}) {
  const subject = overrides.subject ?? "Intro from {{sender_name}}";
  const body = overrides.body ?? "Hello {{first_name}}, reaching out about {{company_name}}.";
  const fields = overrides.fields ?? ["sender_name", "first_name", "company_name"];
  const hash = contentHash(subject, body, fields);
  const info = dbModule
    .db()
    .prepare(
      `INSERT INTO templates (name, segment_id, subject, body, allowed_merge_fields, content_hash, status)
       VALUES ('T', 'owners', ?, ?, ?, ?, 'approved')`
    )
    .run(subject, body, JSON.stringify(fields), hash);
  return { id: Number(info.lastInsertRowid), subject, body, fields, hash };
}

function seedContact(
  overrides: Partial<{ email: string; do_not_contact: number; email_status: string | null; unsubscribed_at: string | null }> = {}
) {
  const email = overrides.email ?? `contact${Math.random().toString(36).slice(2)}@example.com`;
  const info = dbModule
    .db()
    .prepare(
      `INSERT INTO contacts (first_name, last_name, email, email_status, do_not_contact, unsubscribed_at) VALUES ('Dana','Owner',?,?,?,?)`
    )
    .run(email, overrides.email_status ?? "valid", overrides.do_not_contact ?? 0, overrides.unsubscribed_at ?? null);
  return { id: Number(info.lastInsertRowid), email };
}

function seedMailbox(overrides: Partial<{ address: string; warmup_started: string | null; paused: number }> = {}) {
  const address = overrides.address ?? `mailbox${Math.random().toString(36).slice(2)}@sender.test`;
  dbModule
    .db()
    .prepare(`INSERT INTO mailboxes (address, provider, warmup_started, paused) VALUES (?, 'apollo', ?, ?)`)
    .run(address, overrides.warmup_started ?? new Date(2020, 0, 1).toISOString(), overrides.paused ?? 0);
  return { address };
}

function seedMessage(opts: {
  contactId: number;
  template: ReturnType<typeof seedApprovedTemplate>;
  mailbox: string | null;
  merge?: Record<string, string>;
  tamperRenderedBody?: string;
  templateHashOverride?: string;
  omitUnsubscribeToken?: boolean;
  tamperFooter?: string;
  repliedAt?: string | null;
}) {
  const merge = opts.merge ?? { sender_name: "Jordan Hale", first_name: "Dana", company_name: "Acme Co" };
  const token = nextToken();
  const rendered = renderTemplate(
    { subject: opts.template.subject, body: opts.template.body, allowedMergeFields: opts.template.fields },
    merge,
    { unsubscribeUrl: `${process.env.APP_BASE_URL}/u/${token}` }
  );
  if (!rendered.ok) throw new Error(`bad test fixture: ${rendered.error}`);
  const info = dbModule
    .db()
    .prepare(
      `INSERT INTO outbound_messages
        (contact_id, template_id, template_hash, merge_json, rendered_subject, rendered_body, status, mailbox, unsubscribe_token, rendered_footer, replied_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
    )
    .run(
      opts.contactId,
      opts.template.id,
      opts.templateHashOverride ?? opts.template.hash,
      JSON.stringify(merge),
      rendered.subject,
      opts.tamperRenderedBody ?? rendered.body,
      opts.mailbox,
      opts.omitUnsubscribeToken ? null : token,
      opts.omitUnsubscribeToken ? null : opts.tamperFooter ?? rendered.footer,
      opts.repliedAt ?? null
    );
  return Number(info.lastInsertRowid);
}

function baseScenario() {
  const template = seedApprovedTemplate();
  const contact = seedContact();
  const mailbox = seedMailbox();
  const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
  return { template, contact, mailbox, messageId };
}

describe("checkSend", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SEND_DAY);
    await freshDb();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.HARNESS_DB_PATH;
    delete process.env.OUTBOUND_SEND_ENABLED;
    delete process.env.APP_BASE_URL;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("passes when everything is right", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const { messageId } = baseScenario();
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  it.each([
    ["unset", undefined],
    ["0", "0"],
    ["true", "true"],
    [" 1 (with a space)", " 1"],
  ])("blocks when OUTBOUND_SEND_ENABLED is %s", (_label, value) => {
    if (value === undefined) delete process.env.OUTBOUND_SEND_ENABLED;
    else process.env.OUTBOUND_SEND_ENABLED = value;
    const { messageId } = baseScenario();
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /OUTBOUND_SEND_ENABLED/.test(b))).toBe(true);
  });

  it("blocks when the template is not approved", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    dbModule.db().prepare(`UPDATE templates SET status = 'pending' WHERE id = ?`).run(template.id);
    const contact = seedContact();
    const mailbox = seedMailbox();
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /not sendable/i.test(b))).toBe(true);
  });

  it("blocks when the template was edited after the message was queued (hash mismatch)", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact();
    const mailbox = seedMailbox();
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });

    // Edit the template after queueing: new subject/body/hash, still approved.
    const newSubject = "Edited: " + template.subject;
    const newHash = contentHash(newSubject, template.body, template.fields);
    dbModule
      .db()
      .prepare(`UPDATE templates SET subject = ?, content_hash = ? WHERE id = ?`)
      .run(newSubject, newHash, template.id);

    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /hash has changed/i.test(b))).toBe(true);
  });

  it("blocks when the stored rendered body no longer matches a re-render", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact();
    const mailbox = seedMailbox();
    const messageId = seedMessage({
      contactId: contact.id,
      template,
      mailbox: mailbox.address,
      tamperRenderedBody: "This body was tampered with directly in the database.",
    });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /no longer matches the stored rendered content/i.test(b))).toBe(true);
  });

  it("blocks when the contact is do_not_contact", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact({ do_not_contact: 1 });
    const mailbox = seedMailbox();
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /do-not-contact/i.test(b))).toBe(true);
  });

  it("blocks when the email is on the suppression table", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact({ email: "suppressed@example.com" });
    dbModule.db().prepare(`INSERT INTO suppression (email, reason) VALUES (?, 'bounced')`).run(contact.email);
    const mailbox = seedMailbox();
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /suppression/i.test(b))).toBe(true);
  });

  it("blocks when email_status is no-mx", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact({ email_status: "no-mx" });
    const mailbox = seedMailbox();
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /no mx record/i.test(b))).toBe(true);
  });

  it("blocks when another message went to the same contact within 7 days", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact();
    const mailbox = seedMailbox();
    const priorMessageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    dbModule
      .db()
      .prepare(`UPDATE outbound_messages SET status = 'sent', sent_at = datetime('now', '-2 days') WHERE id = ?`)
      .run(priorMessageId);

    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /already received a message in the last 7 days/i.test(b))).toBe(true);
  });

  it("blocks when the mailbox is paused", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact();
    const mailbox = seedMailbox({ paused: 1 });
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /mailbox is paused/i.test(b))).toBe(true);
  });

  it("blocks when the mailbox is at its daily cap", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    // Mailbox started warmup today: week-0 cap is 5/day.
    const mailbox = seedMailbox({ warmup_started: SEND_DAY.toISOString() });

    // Fill the cap with 5 already-sent messages today, each to a distinct contact
    // (contacts have a 7-day cooldown, so reuse would trip a different block).
    for (let i = 0; i < 5; i++) {
      const c = seedContact();
      const mid = seedMessage({ contactId: c.id, template, mailbox: mailbox.address });
      dbModule
        .db()
        .prepare(`UPDATE outbound_messages SET status = 'sent', sent_at = datetime('now') WHERE id = ?`)
        .run(mid);
    }

    const contact = seedContact();
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /at today's cap/i.test(b))).toBe(true);
  });

  it("writes an audit_log row with action message.block and sets the message to held, on any block", () => {
    // OUTBOUND_SEND_ENABLED left unset on purpose to force a block.
    const { messageId } = baseScenario();
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);

    const message = dbModule
      .db()
      .prepare(`SELECT status FROM outbound_messages WHERE id = ?`)
      .get(messageId) as { status: string };
    expect(message.status).toBe("held");

    const auditRow = dbModule
      .db()
      .prepare(`SELECT action, entity, entity_id, detail_json FROM audit_log WHERE entity_id = ? ORDER BY id DESC LIMIT 1`)
      .get(messageId) as { action: string; entity: string; entity_id: number; detail_json: string };
    expect(auditRow.action).toBe("message.block");
    expect(auditRow.entity).toBe("outbound_message");
    const detail = JSON.parse(auditRow.detail_json);
    expect(Array.isArray(detail.reasons)).toBe(true);
    expect(detail.reasons.length).toBeGreaterThan(0);
  });

  it("blocks when the contact has unsubscribed", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact({ unsubscribed_at: new Date().toISOString() });
    const mailbox = seedMailbox();
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /unsubscribed/i.test(b))).toBe(true);
  });

  it("blocks when the contact has an inbound reply on record", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact();
    const mailbox = seedMailbox();
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    dbModule
      .db()
      .prepare(
        `INSERT INTO inbound_replies (contact_id, from_email, kind, received_at) VALUES (?, ?, 'reply', datetime('now'))`
      )
      .run(contact.id, contact.email);
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /replied/i.test(b))).toBe(true);
  });

  it("blocks when the message's own replied_at is set, even with no inbound_replies row", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact();
    const mailbox = seedMailbox();
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address, repliedAt: new Date().toISOString() });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /replied/i.test(b))).toBe(true);
  });

  it("blocks when the message has no unsubscribe token or footer on record", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact();
    const mailbox = seedMailbox();
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address, omitUnsubscribeToken: true });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /no unsubscribe link/i.test(b))).toBe(true);
  });

  it("blocks when the stored footer no longer matches a re-render (e.g. the footer template changed)", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const template = seedApprovedTemplate();
    const contact = seedContact();
    const mailbox = seedMailbox();
    const messageId = seedMessage({
      contactId: contact.id,
      template,
      mailbox: mailbox.address,
      tamperFooter: "Some other footer entirely, not what would be re-rendered.",
    });
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((b) => /footer/i.test(b))).toBe(true);
  });

  it("passes a clock explicitly via the now parameter instead of relying on the real wall clock", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    // Mailbox starts warmup "today" per the injected clock, a Monday, so it has capacity.
    const template = seedApprovedTemplate();
    const contact = seedContact();
    const mailbox = seedMailbox({ warmup_started: SEND_DAY.toISOString() });
    const messageId = seedMessage({ contactId: contact.id, template, mailbox: mailbox.address });
    const result = sendGateModule.checkSend(messageId, SEND_DAY);
    expect(result.ok).toBe(true);
  });

  it("does not write an audit_log row or change status when checkSend passes", () => {
    process.env.OUTBOUND_SEND_ENABLED = "1";
    const { messageId } = baseScenario();
    const before = dbModule.db().prepare(`SELECT COUNT(*) as n FROM audit_log`).get() as { n: number };
    const result = sendGateModule.checkSend(messageId);
    expect(result.ok).toBe(true);
    const after = dbModule.db().prepare(`SELECT COUNT(*) as n FROM audit_log`).get() as { n: number };
    expect(after.n).toBe(before.n);
    const message = dbModule.db().prepare(`SELECT status FROM outbound_messages WHERE id = ?`).get(messageId) as {
      status: string;
    };
    expect(message.status).toBe("queued");
  });
});

describe("DryRunProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("performs no network I/O and still resolves ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("network I/O attempted by DryRunProvider");
      })
    );
    const { DryRunProvider } = await import("../app/lib/outbound/provider");
    const provider = new DryRunProvider();
    const result = await provider.send({
      messageId: 1,
      mailboxAddress: "sender@sender.test",
      toEmail: "dana@example.com",
      subject: "Hi",
      body: "Body",
    });
    expect(result.ok).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
