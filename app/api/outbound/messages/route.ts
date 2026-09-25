export const runtime = "nodejs";
// Browse queued/held/sent/failed/cancelled messages. Read-only list; POST is
// not exposed here (queueing lives at /api/outbound/queue).
import { db } from "../../../lib/db";
import { requireUser } from "../../../lib/session";

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);

  const rows = status
    ? db()
        .prepare(
          `SELECT m.id, m.status, m.mailbox, m.scheduled_for, m.sent_at, m.error, m.provider_id, m.rendered_subject,
                  c.first_name, c.last_name, c.email
           FROM outbound_messages m JOIN contacts c ON c.id = m.contact_id
           WHERE m.status = ?
           ORDER BY m.id DESC LIMIT ?`
        )
        .all(status, limit)
    : db()
        .prepare(
          `SELECT m.id, m.status, m.mailbox, m.scheduled_for, m.sent_at, m.error, m.provider_id, m.rendered_subject,
                  c.first_name, c.last_name, c.email
           FROM outbound_messages m JOIN contacts c ON c.id = m.contact_id
           ORDER BY m.id DESC LIMIT ?`
        )
        .all(limit);

  const counts = db()
    .prepare(`SELECT status, COUNT(*) as n FROM outbound_messages GROUP BY status`)
    .all() as { status: string; n: number }[];

  return Response.json({ messages: rows, counts });
}
