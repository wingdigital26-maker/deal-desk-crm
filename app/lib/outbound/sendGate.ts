// Re-verifies everything at the moment of send, independent of what the queue
// step already checked. Any single failure holds the message; every failing
// reason is collected and audited so a human can see exactly why.
import { db, audit } from "../db";
import { firm } from "../../../firm.config";
import { isSendable, renderTemplate, lintText, type SendableTemplateInput } from "../compliance";
import { dailyCapForMailbox } from "./ramp";
import { unsubscribeUrlFor } from "./unsubscribe";

export type CheckSendResult = { ok: boolean; blocks: string[] };

type MessageRow = {
  id: number;
  contact_id: number;
  template_id: number;
  template_hash: string;
  merge_json: string;
  rendered_subject: string;
  rendered_body: string;
  status: string;
  mailbox: string | null;
  scheduled_for: string | null;
  unsubscribe_token: string | null;
  rendered_footer: string | null;
  replied_at: string | null;
};

type TemplateRow = SendableTemplateInput & { id: number };

type ContactRow = {
  id: number;
  email: string | null;
  do_not_contact: number;
  email_status: string | null;
  unsubscribed_at: string | null;
};

type MailboxRow = {
  id: number;
  address: string;
  warmup_started: string | null;
  paused: number;
  daily_cap: number | null;
};

export function checkSend(messageId: number, now: Date = new Date()): CheckSendResult {
  const blocks: string[] = [];

  const message = db()
    .prepare(
      `SELECT id, contact_id, template_id, template_hash, merge_json, rendered_subject,
              rendered_body, status, mailbox, scheduled_for, unsubscribe_token, rendered_footer, replied_at
       FROM outbound_messages WHERE id = ?`
    )
    .get(messageId) as MessageRow | undefined;

  if (!message) {
    return { ok: false, blocks: ["Message not found."] };
  }

  // 1. Global send switch. Must be exactly "1".
  if (process.env.OUTBOUND_SEND_ENABLED !== "1") {
    blocks.push("OUTBOUND_SEND_ENABLED is not set to \"1\".");
  }

  // 2. Template still approved and its hash matches what was queued.
  const template = db()
    .prepare(
      `SELECT id, status, content_hash, subject, body, allowed_merge_fields
       FROM templates WHERE id = ?`
    )
    .get(message.template_id) as TemplateRow | undefined;

  if (!template) {
    blocks.push("Template no longer exists.");
  } else {
    const sendable = isSendable(template);
    if (!sendable.ok) {
      blocks.push(`Template is not sendable: ${sendable.reason}`);
    }
    if (template.content_hash !== message.template_hash) {
      blocks.push("Template content hash has changed since this message was queued.");
    }

    // 3. Re-render from the stored merge values and compare to what is stored.
    let merge: Record<string, string> = {};
    try {
      merge = JSON.parse(message.merge_json);
    } catch {
      blocks.push("Stored merge values could not be parsed.");
    }

    if (!message.unsubscribe_token || !message.rendered_footer) {
      blocks.push("Message has no unsubscribe link on record.");
    } else {
      try {
        const rerendered = renderTemplate(
          { subject: template.subject, body: template.body, allowedMergeFields: JSON.parse(template.allowed_merge_fields) },
          merge,
          { unsubscribeUrl: unsubscribeUrlFor(message.unsubscribe_token) }
        );
        if (!rerendered.ok) {
          blocks.push(`Re-render failed: ${rerendered.error}`);
        } else {
          if (rerendered.subject !== message.rendered_subject || rerendered.body !== message.rendered_body) {
            blocks.push("Re-rendered content no longer matches the stored rendered content.");
          }
          if (rerendered.footer !== message.rendered_footer) {
            blocks.push("Re-rendered footer no longer matches the stored footer. The footer may have changed since this message was queued.");
          }
        }
      } catch (err) {
        blocks.push(err instanceof Error ? err.message : "Could not rebuild the unsubscribe link.");
      }
    }

    // 4. Lint the rendered body; zero "block" findings allowed.
    const lint = lintText(message.rendered_body);
    const hardBlocks = lint.filter((f) => f.severity === "block");
    if (hardBlocks.length > 0) {
      blocks.push(`Content fails voice rules: ${hardBlocks.map((f) => f.message).join("; ")}`);
    }
  }

  // 5. Contact eligibility.
  const contact = db()
    .prepare(`SELECT id, email, do_not_contact, email_status, unsubscribed_at FROM contacts WHERE id = ?`)
    .get(message.contact_id) as ContactRow | undefined;

  if (!contact) {
    blocks.push("Contact no longer exists.");
  } else {
    if (!contact.email) blocks.push("Contact has no email address.");
    if (contact.do_not_contact) blocks.push("Contact is marked do-not-contact.");
    if (contact.unsubscribed_at) blocks.push("Contact unsubscribed and must never be emailed again.");
    if (contact.email && isSuppressed(contact.email)) blocks.push("Contact email is on the suppression list.");
    if (contact.email_status === "no-mx") blocks.push("Contact email has no MX record.");

    // A person who answered is never emailed by the machine again.
    if (message.replied_at) {
      blocks.push("This message's contact already replied. The machine does not email a contact again after a reply.");
    } else {
      const reply = db()
        .prepare(`SELECT id FROM inbound_replies WHERE contact_id = ? AND kind = 'reply' LIMIT 1`)
        .get(contact.id) as { id: number } | undefined;
      if (reply) blocks.push("Contact has replied. The machine does not email a contact again after a reply.");
    }

    // 6. One message per contact per 7 days.
    if (contact.email) {
      const recent = db()
        .prepare(
          `SELECT COUNT(*) as n FROM outbound_messages
           WHERE contact_id = ? AND id != ? AND status = 'sent'
             AND sent_at IS NOT NULL AND sent_at >= datetime('now', '-7 days')`
        )
        .get(contact.id, message.id) as { n: number };
      if (recent.n > 0) {
        blocks.push("Contact already received a message in the last 7 days.");
      }
    }
  }

  // 7. Mailbox eligibility and today's cap.
  if (!message.mailbox) {
    blocks.push("Message has no mailbox assigned.");
  } else {
    const mailbox = db()
      .prepare(`SELECT id, address, warmup_started, paused, daily_cap FROM mailboxes WHERE address = ?`)
      .get(message.mailbox) as MailboxRow | undefined;

    if (!mailbox) {
      blocks.push("Assigned mailbox no longer exists.");
    } else if (mailbox.paused) {
      blocks.push("Assigned mailbox is paused.");
    } else {
      // A recorded provider daily cap (e.g. Instantly's daily_limit) can only lower this.
      const cap = dailyCapForMailbox(mailbox.warmup_started, now, firm.outbound, !!mailbox.paused, mailbox.daily_cap ?? null);
      if (cap <= 0) {
        blocks.push("Assigned mailbox has zero capacity today (warmup not started, or not a send day).");
      } else {
        const sentToday = db()
          .prepare(
            `SELECT COUNT(*) as n FROM outbound_messages
             WHERE mailbox = ? AND status = 'sent' AND date(sent_at) = date('now')`
          )
          .get(mailbox.address) as { n: number };
        if (sentToday.n >= cap) {
          blocks.push(`Assigned mailbox is at today's cap (${cap}).`);
        }
      }
    }
  }

  if (blocks.length > 0) {
    db().prepare(`UPDATE outbound_messages SET status = 'held' WHERE id = ?`).run(message.id);
    audit({
      action: "message.block",
      entity: "outbound_message",
      entityId: message.id,
      detail: { reasons: blocks },
    });
    return { ok: false, blocks };
  }

  return { ok: true, blocks: [] };
}

function isSuppressed(email: string): boolean {
  const row = db().prepare(`SELECT email FROM suppression WHERE email = ?`).get(email.toLowerCase());
  if (row) return true;
  // Also check exact-case stored values, since suppression entries may not be
  // lowercased at insert time by every caller.
  const rowExact = db().prepare(`SELECT email FROM suppression WHERE email = ?`).get(email);
  return !!rowExact;
}
