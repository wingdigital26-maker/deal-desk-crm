export const runtime = "nodejs";
// Cancel a queued or held message so it can never be picked up by a run.
// Any signed-in user can cancel (mirrors suppression add: catching a mistake
// before it sends should not need a special role); only queued/held messages
// are cancellable, everything else is a no-op 409.
import { db, audit } from "../../../../../lib/db";
import { requireUser } from "../../../../../lib/session";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const { id } = await params;
  const messageId = Number(id);
  if (!Number.isInteger(messageId)) return Response.json({ error: "Invalid id." }, { status: 400 });

  const message = db().prepare(`SELECT id, status FROM outbound_messages WHERE id = ?`).get(messageId) as
    | { id: number; status: string }
    | undefined;

  if (!message) return Response.json({ error: "Message not found." }, { status: 404 });
  if (message.status !== "queued" && message.status !== "held") {
    return Response.json({ error: `Cannot cancel a message that is already ${message.status}.` }, { status: 409 });
  }

  db().prepare(`UPDATE outbound_messages SET status = 'cancelled' WHERE id = ?`).run(messageId);
  audit({
    actorUserId: user.id,
    action: "message.cancel",
    entity: "outbound_message",
    entityId: messageId,
  });

  return Response.json({ ok: true });
}
