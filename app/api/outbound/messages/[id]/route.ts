export const runtime = "nodejs";
// One message with full rendered content, for the "open one" queue detail view.
import { db } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const { id } = await params;
  const messageId = Number(id);
  if (!Number.isInteger(messageId)) return Response.json({ error: "Invalid id." }, { status: 400 });

  const message = db()
    .prepare(
      `SELECT m.*, c.first_name, c.last_name, c.email, t.name as template_name
       FROM outbound_messages m
       JOIN contacts c ON c.id = m.contact_id
       JOIN templates t ON t.id = m.template_id
       WHERE m.id = ?`
    )
    .get(messageId);

  if (!message) return Response.json({ error: "Message not found." }, { status: 404 });
  return Response.json({ message });
}
