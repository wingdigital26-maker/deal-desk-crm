export const runtime = "nodejs";
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import { isValidEmail } from "../../../lib/csv";
import * as v from "../../../lib/validate";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const row = db().prepare("SELECT * FROM contacts WHERE id = ?").get(Number(id));
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ row });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const contactId = Number(id);
  const existing = db().prepare("SELECT * FROM contacts WHERE id = ?").get(contactId) as
    | { id: number; email: string | null }
    | undefined;
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Invalid body" }, { status: 400 });

  // Special action: toggling do-not-contact also writes suppression + audits.
  if ("do_not_contact" in body && Object.keys(body).length === 1) {
    const value = body.do_not_contact ? 1 : 0;
    db().prepare("UPDATE contacts SET do_not_contact = ?, updated_at = datetime('now') WHERE id = ?").run(value, contactId);
    if (value === 1 && existing.email) {
      db()
        .prepare("INSERT OR IGNORE INTO suppression (email, reason) VALUES (?, 'manual')")
        .run(existing.email);
    }
    audit({
      actorUserId: user.id,
      actorLabel: user.email,
      action: value ? "contact.do_not_contact.set" : "contact.do_not_contact.unset",
      entity: "contact",
      entityId: contactId,
      detail: { email: existing.email },
    });
    return Response.json({ ok: true });
  }

  const fields: Record<string, string | number | null> = {};
  try {
    if ("first_name" in body || "last_name" in body) {
      const firstName = v.name("first_name", body.first_name);
      const lastName = v.name("last_name", body.last_name);
      if (!firstName && !lastName) return Response.json({ error: "First or last name is required" }, { status: 400 });
      if ("first_name" in body) fields.first_name = firstName;
      if ("last_name" in body) fields.last_name = lastName;
    }
    if ("email" in body) {
      const email = str(body.email)?.toLowerCase() ?? null;
      if (email && !isValidEmail(email)) return Response.json({ error: "That email address does not look valid" }, { status: 400 });
      if (email) {
        const dupe = db().prepare("SELECT id FROM contacts WHERE email = ? AND id != ?").get(email, contactId) as
          | { id: number }
          | undefined;
        if (dupe) return Response.json({ error: "Another contact already uses this email" }, { status: 409 });
      }
      fields.email = email;
    }
    if ("title" in body) fields.title = v.title("title", body.title);
    if ("email_status" in body) fields.email_status = str(body.email_status);
    if ("phone" in body) fields.phone = str(body.phone);
    if ("linkedin_url" in body) fields.linkedin_url = v.url("linkedin_url", body.linkedin_url);
    if ("touch_every_days" in body) {
      fields.touch_every_days = v.integerRange("touch_every_days", body.touch_every_days, 1, 730);
    }
    if ("company_id" in body) {
      fields.company_id =
        body.company_id != null && body.company_id !== ""
          ? v.integerRange("company_id", body.company_id, 1, Number.MAX_SAFE_INTEGER)
          : null;
    }
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }

  if (Object.keys(fields).length === 0) return Response.json({ error: "Nothing to update" }, { status: 400 });

  const setSql = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(", ");
  db()
    .prepare(`UPDATE contacts SET ${setSql}, updated_at = datetime('now') WHERE id = ?`)
    .run(...Object.values(fields), contactId);

  audit({ actorUserId: user.id, actorLabel: user.email, action: "contact.update", entity: "contact", entityId: contactId, detail: fields });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;
  const { id } = await params;
  const contactId = Number(id);
  const existing = db().prepare("SELECT id, email FROM contacts WHERE id = ?").get(contactId) as
    | { id: number; email: string | null }
    | undefined;
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  // outbound_messages cascades on contact delete. A message with status
  // 'sent' is a record of mail actually sent (FINRA 17a-4) and must survive,
  // so block the delete rather than let the cascade destroy it. (The
  // separate outbound_pushes archive is unaffected either way: it only
  // SET NULLs the contact_id.)
  const sentCount = db()
    .prepare("SELECT COUNT(*) AS n FROM outbound_messages WHERE contact_id = ? AND status = 'sent'")
    .get(contactId) as { n: number };
  if (sentCount.n > 0) {
    return Response.json(
      { error: "This contact has sent emails on record, which must be kept. Mark them do-not-contact instead." },
      { status: 409 }
    );
  }

  db().prepare("DELETE FROM contacts WHERE id = ?").run(contactId);
  audit({ actorUserId: user.id, actorLabel: user.email, action: "contact.delete", entity: "contact", entityId: contactId, detail: { email: existing.email } });
  return Response.json({ ok: true });
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
