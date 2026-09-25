export const runtime = "nodejs";
// Queues rendered messages for a template against a list of contacts.
// Renders per contact from allow-listed merge fields only, records the
// template hash at queue time, and schedules across mailboxes within their
// daily caps over the coming send days. Contacts that fail render or
// suppression are skipped and reported, never silently dropped.
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import { firm } from "../../../../firm.config";
import { renderTemplate, isSendable, type SendableTemplateInput } from "../../../lib/compliance";
import { dailyCapForMailbox } from "../../../lib/outbound/ramp";
import { generateUnsubscribeToken, unsubscribeUrlFor } from "../../../lib/outbound/unsubscribe";

type TemplateRow = SendableTemplateInput & {
  id: number;
  segment_id: string;
};

type ContactRow = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  email_status: string | null;
  do_not_contact: number;
  company_id: number | null;
};

type MailboxRow = { id: number; address: string; warmup_started: string | null; paused: number };

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  let payload: { templateId?: number; contactIds?: number[] };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const templateId = Number(payload.templateId);
  const contactIds = Array.isArray(payload.contactIds) ? payload.contactIds.map(Number) : [];
  if (!Number.isInteger(templateId) || contactIds.length === 0) {
    return Response.json({ error: "templateId and a non-empty contactIds array are required." }, { status: 400 });
  }

  const template = db()
    .prepare(
      `SELECT id, segment_id, status, content_hash, subject, body, allowed_merge_fields
       FROM templates WHERE id = ?`
    )
    .get(templateId) as TemplateRow | undefined;

  if (!template) return Response.json({ error: "Template not found." }, { status: 404 });

  const sendable = isSendable(template);
  if (!sendable.ok) {
    return Response.json({ error: `Template is not sendable: ${sendable.reason}` }, { status: 409 });
  }

  // Every message needs a working unsubscribe link. Fail the whole request up
  // front with a clear message rather than queueing messages with a broken
  // or missing opt-out (checked once here, not per contact).
  if (!process.env.APP_BASE_URL) {
    return Response.json(
      { error: "APP_BASE_URL is not set. Cannot generate a working unsubscribe link for these messages." },
      { status: 500 }
    );
  }

  const allowedFields: string[] = JSON.parse(template.allowed_merge_fields);

  const mailboxes = db()
    .prepare(`SELECT id, address, warmup_started, paused FROM mailboxes WHERE paused = 0`)
    .all() as MailboxRow[];

  // Track how many messages have been scheduled per mailbox per future date,
  // in memory for this single request, so a big batch is spread across caps
  // instead of piling every message on today.
  const scheduledCountByMailboxDate = new Map<string, number>();
  const today = new Date();
  const upcomingSendDates = nextSendDates(today, 30); // enough runway for large batches

  function nextAvailableSlot(): { mailbox: MailboxRow; date: string } | null {
    for (const dateStr of upcomingSendDates) {
      const date = new Date(dateStr);
      for (const mb of mailboxes) {
        const cap = dailyCapForMailbox(mb.warmup_started, date, firm.outbound, !!mb.paused);
        if (cap <= 0) continue;
        const key = `${mb.address}|${dateStr}`;
        const used = scheduledCountByMailboxDate.get(key) ?? 0;
        if (used < cap) {
          scheduledCountByMailboxDate.set(key, used + 1);
          return { mailbox: mb, date: dateStr };
        }
      }
    }
    return null;
  }

  const queued: number[] = [];
  const skipped: { contactId: number; reason: string }[] = [];

  const insert = db().prepare(
    `INSERT INTO outbound_messages
       (contact_id, template_id, template_hash, merge_json, rendered_subject, rendered_body, lint_json, status, mailbox, scheduled_for, unsubscribe_token, rendered_footer)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  for (const contactId of contactIds) {
    const contact = db()
      .prepare(
        `SELECT c.id, c.first_name, c.last_name, c.email, c.email_status, c.do_not_contact, c.company_id
         FROM contacts c WHERE c.id = ?`
      )
      .get(contactId) as ContactRow | undefined;

    if (!contact) {
      skipped.push({ contactId, reason: "Contact not found." });
      continue;
    }
    if (!contact.email) {
      skipped.push({ contactId, reason: "Contact has no email." });
      continue;
    }
    if (contact.do_not_contact) {
      skipped.push({ contactId, reason: "Contact is marked do-not-contact." });
      continue;
    }
    if (contact.email_status === "no-mx") {
      skipped.push({ contactId, reason: "Contact email has no MX record." });
      continue;
    }
    const onDoNotContactList = db().prepare(`SELECT email FROM suppression WHERE email = ?`).get(contact.email);
    if (onDoNotContactList) {
      skipped.push({ contactId, reason: "Contact email is on the do-not-contact list." });
      continue;
    }

    let companyName = "";
    if (contact.company_id) {
      const company = db().prepare(`SELECT name FROM companies WHERE id = ?`).get(contact.company_id) as
        | { name: string }
        | undefined;
      companyName = company?.name ?? "";
    }

    const merge: Record<string, string> = {};
    if (allowedFields.includes("first_name")) merge.first_name = contact.first_name ?? "";
    if (allowedFields.includes("last_name")) merge.last_name = contact.last_name ?? "";
    if (allowedFields.includes("company_name")) merge.company_name = companyName;

    const unsubscribeToken = generateUnsubscribeToken();
    const rendered = renderTemplate(
      { subject: template.subject, body: template.body, allowedMergeFields: allowedFields },
      merge,
      { unsubscribeUrl: unsubscribeUrlFor(unsubscribeToken) }
    );
    if (!rendered.ok) {
      skipped.push({ contactId, reason: rendered.error });
      continue;
    }

    const slot = nextAvailableSlot();
    if (!slot) {
      skipped.push({ contactId, reason: "No mailbox capacity available in the scheduling window." });
      continue;
    }

    const info = insert.run(
      contact.id,
      template.id,
      template.content_hash,
      JSON.stringify(merge),
      rendered.subject,
      rendered.body,
      JSON.stringify([]),
      "queued",
      slot.mailbox.address,
      slot.date,
      unsubscribeToken,
      rendered.footer
    );
    queued.push(Number(info.lastInsertRowid));
  }

  audit({
    actorUserId: user.id,
    action: "message.queue",
    entity: "template",
    entityId: template.id,
    detail: { queuedCount: queued.length, skippedCount: skipped.length },
  });

  return Response.json({ queued, skipped });
}

function nextSendDates(from: Date, count: number): string[] {
  const out: string[] = [];
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const sendDays: readonly number[] = firm.outbound.sendDays;
  while (out.length < count) {
    if (sendDays.includes(d.getDay())) {
      out.push(d.toISOString().slice(0, 10));
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}
