export const runtime = "nodejs";

import { db, audit } from "../../lib/db";
import { requireUser } from "../../lib/session";
import * as v from "../../lib/validate";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const rows = db()
    .prepare(
      `SELECT t.*, d.title AS deal_title, c.first_name AS contact_first_name, c.last_name AS contact_last_name
       FROM tasks t
       LEFT JOIN deals d ON d.id = t.deal_id
       LEFT JOIN contacts c ON c.id = t.contact_id
       ORDER BY (t.due IS NULL), t.due ASC, t.created_at ASC`
    )
    .all();

  return Response.json({ items: rows });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let title: string, due: string | null, dealId: number | null, contactId: number | null;
  try {
    title = v.title("title", body.title, { required: true })!;
    due = v.isoDate("due", body.due);
    dealId =
      body.deal_id != null && body.deal_id !== ""
        ? v.integerRange("deal_id", body.deal_id, 1, Number.MAX_SAFE_INTEGER)
        : null;
    contactId =
      body.contact_id != null && body.contact_id !== ""
        ? v.integerRange("contact_id", body.contact_id, 1, Number.MAX_SAFE_INTEGER)
        : null;
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }

  if (dealId) {
    const deal = db().prepare("SELECT id FROM deals WHERE id = ?").get(dealId);
    if (!deal) return Response.json({ error: "Unknown deal_id" }, { status: 400 });
  }
  if (contactId) {
    const contact = db().prepare("SELECT id FROM contacts WHERE id = ?").get(contactId);
    if (!contact) return Response.json({ error: "Unknown contact_id" }, { status: 400 });
  }

  const result = db()
    .prepare(`INSERT INTO tasks (title, due, deal_id, contact_id) VALUES (?, ?, ?, ?)`)
    .run(title, due, dealId, contactId);

  const taskId = Number(result.lastInsertRowid);

  audit({
    actorUserId: user.id,
    action: "task.create",
    entity: "task",
    entityId: taskId,
    detail: { title, due, deal_id: dealId },
  });

  if (dealId) {
    db()
      .prepare(`INSERT INTO activities (kind, body, deal_id, user_id) VALUES ('note', ?, ?, ?)`)
      .run(`Task added: ${title}`, dealId, user.id);
  }

  const created = db().prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  return Response.json({ item: created }, { status: 201 });
}
