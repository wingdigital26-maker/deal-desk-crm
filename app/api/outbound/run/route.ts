export const runtime = "nodejs";
// The ONLY path that sends. Owner-only, manual (no cron, no auto-run).
// Processes messages that are due, re-verifies each one with checkSend, and
// only on a clean pass hands it to the configured provider.
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import { checkSend } from "../../../lib/outbound/sendGate";
import { getProvider, InstantlyProvider } from "../../../lib/outbound/provider";
import { recordPush } from "../../../lib/outbound/records";

type DueMessage = {
  id: number;
  contact_id: number;
  mailbox: string | null;
  rendered_subject: string;
  rendered_body: string;
  rendered_footer: string | null;
};

export async function POST(req: Request) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  let payload: { limit?: number } = {};
  try {
    payload = await req.json();
  } catch {
    // no body is fine; default limit applies
  }
  const limit = Number.isInteger(payload.limit) && (payload.limit as number) > 0 ? (payload.limit as number) : 50;

  const due = db()
    .prepare(
      `SELECT id, contact_id, mailbox, rendered_subject, rendered_body, rendered_footer
       FROM outbound_messages
       WHERE status = 'queued' AND (scheduled_for IS NULL OR date(scheduled_for) <= date('now'))
       ORDER BY scheduled_for ASC, id ASC
       LIMIT ?`
    )
    .all(limit) as DueMessage[];

  const provider = getProvider();
  const results: { messageId: number; status: "sent" | "held" | "failed"; detail?: string }[] = [];

  for (const msg of due) {
    const check = checkSend(msg.id);
    if (!check.ok) {
      results.push({ messageId: msg.id, status: "held", detail: check.blocks.join("; ") });
      continue;
    }

    const contact = db()
      .prepare(
        `SELECT c.email, c.first_name, c.last_name, co.name AS company_name
         FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = ?`
      )
      .get(msg.contact_id) as
      | { email: string | null; first_name: string | null; last_name: string | null; company_name: string | null }
      | undefined;

    if (!contact?.email) {
      db().prepare(`UPDATE outbound_messages SET status = 'held' WHERE id = ?`).run(msg.id);
      audit({
        actorUserId: user.id,
        action: "message.block",
        entity: "outbound_message",
        entityId: msg.id,
        detail: { reasons: ["Contact email disappeared between check and send."] },
      });
      results.push({ messageId: msg.id, status: "held", detail: "Contact email missing." });
      continue;
    }

    try {
      // The footer (legal address + unsubscribe link) is stored separately
      // from the body but is part of what was approved and re-verified by
      // checkSend above; it is appended here so the actual outbound content
      // matches exactly what the compliance layer just re-checked.
      const fullBody = msg.rendered_footer ? `${msg.rendered_body}\n\n${msg.rendered_footer}` : msg.rendered_body;

      const sendResult = await provider.send({
        messageId: msg.id,
        mailboxAddress: msg.mailbox ?? "",
        toEmail: contact.email,
        subject: msg.rendered_subject,
        body: fullBody,
        lead: { firstName: contact.first_name, lastName: contact.last_name, companyName: contact.company_name },
      });

      if (sendResult.ok) {
        db()
          .prepare(
            `UPDATE outbound_messages SET status = 'sent', sent_at = datetime('now'), provider_id = ? WHERE id = ?`
          )
          .run(sendResult.providerId, msg.id);
        audit({
          actorUserId: user.id,
          action: "message.send",
          entity: "outbound_message",
          entityId: msg.id,
          detail: { provider: provider.name, providerId: sendResult.providerId },
        });
        if (provider instanceof InstantlyProvider) {
          // Append-only record of the exact text handed to Instantly, plus the timeline entry.
          recordPush({
            messageId: msg.id,
            contactId: msg.contact_id,
            provider: "instantly",
            providerLabel: "Instantly",
            campaignId: provider.campaignId,
            toEmail: contact.email,
            subject: msg.rendered_subject,
            body: fullBody,
            providerRef: sendResult.providerId,
            actorUserId: user.id,
          });
        }
        results.push({ messageId: msg.id, status: "sent" });
      } else {
        db()
          .prepare(`UPDATE outbound_messages SET status = 'failed', error = ? WHERE id = ?`)
          .run(sendResult.error, msg.id);
        audit({
          actorUserId: user.id,
          action: "message.send",
          entity: "outbound_message",
          entityId: msg.id,
          detail: { provider: provider.name, ok: false, error: sendResult.error },
        });
        results.push({ messageId: msg.id, status: "failed", detail: sendResult.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown provider error.";
      db().prepare(`UPDATE outbound_messages SET status = 'failed', error = ? WHERE id = ?`).run(message, msg.id);
      audit({
        actorUserId: user.id,
        action: "message.send",
        entity: "outbound_message",
        entityId: msg.id,
        detail: { provider: provider.name, ok: false, error: message },
      });
      results.push({ messageId: msg.id, status: "failed", detail: message });
    }
  }

  return Response.json({ processed: results.length, results });
}
