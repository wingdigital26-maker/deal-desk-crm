// Books and records (FINRA 17a-4 / 3110) for messages handed to an external
// sender. Insert-only: nothing in this app issues UPDATE or DELETE against
// outbound_pushes. The contact timeline also gets the full text, labelled
// with the sender that will deliver it.
import { db, audit } from "../db";

export type PushRecordInput = {
  messageId: number;
  contactId: number;
  provider: string; // e.g. "instantly"
  providerLabel: string; // e.g. "Instantly", shown on the timeline
  campaignId: string | null;
  toEmail: string;
  subject: string;
  body: string; // full body as pushed, footer included
  providerRef: string | null;
  actorUserId?: number | null;
};

export function recordPush(input: PushRecordInput): number {
  const info = db()
    .prepare(
      `INSERT INTO outbound_pushes (message_id, contact_id, provider, campaign_id, to_email, subject, body, provider_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.messageId,
      input.contactId,
      input.provider,
      input.campaignId,
      input.toEmail,
      input.subject,
      input.body,
      input.providerRef
    );
  const pushId = Number(info.lastInsertRowid);

  const contact = db().prepare(`SELECT company_id FROM contacts WHERE id = ?`).get(input.contactId) as
    | { company_id: number | null }
    | undefined;
  db()
    .prepare(`INSERT INTO activities (kind, body, company_id, contact_id, user_id) VALUES ('email-out', ?, ?, ?, ?)`)
    .run(
      `Sent via ${input.providerLabel}: ${input.subject}\n\n${input.body}`,
      contact?.company_id ?? null,
      input.contactId,
      input.actorUserId ?? null
    );

  audit({
    actorUserId: input.actorUserId ?? null,
    action: "message.push.record",
    entity: "outbound_push",
    entityId: pushId,
    detail: { messageId: input.messageId, provider: input.provider, campaignId: input.campaignId, providerRef: input.providerRef },
  });
  return pushId;
}
