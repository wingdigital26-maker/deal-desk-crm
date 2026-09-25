export const runtime = "nodejs";
// Removing a suppression entry re-enables sending to that address, so it is
// owner-only and always audited.
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";

export async function DELETE(_req: Request, { params }: { params: Promise<{ email: string }> }) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  const { email } = await params;
  const decoded = decodeURIComponent(email).trim().toLowerCase();

  const row = db().prepare(`SELECT email FROM suppression WHERE email = ?`).get(decoded);
  if (!row) return Response.json({ error: "Not on the suppression list." }, { status: 404 });

  db().prepare(`DELETE FROM suppression WHERE email = ?`).run(decoded);
  audit({
    actorUserId: user.id,
    action: "suppression.remove",
    entity: "suppression",
    detail: { email: decoded },
  });

  return Response.json({ ok: true });
}
