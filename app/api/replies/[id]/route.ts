export const runtime = "nodejs";
// Mark a reply handled (or unhandled, if the client passes handled:false).
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const { id } = await params;
  const replyId = Number(id);
  if (!Number.isInteger(replyId)) return Response.json({ error: "Invalid id." }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // Body is optional; default to marking it handled.
  }
  const handled = body.handled === false ? 0 : 1;

  const row = db().prepare(`SELECT id FROM inbound_replies WHERE id = ?`).get(replyId);
  if (!row) return Response.json({ error: "Reply not found." }, { status: 404 });

  db().prepare(`UPDATE inbound_replies SET handled = ? WHERE id = ?`).run(handled, replyId);
  audit({
    actorUserId: user.id,
    action: "reply.mark_handled",
    entity: "inbound_reply",
    entityId: replyId,
    detail: { handled: !!handled },
  });

  return Response.json({ ok: true });
}
