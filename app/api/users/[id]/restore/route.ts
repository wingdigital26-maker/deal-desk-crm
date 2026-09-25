export const runtime = "nodejs";
// Restore access: sets disabled = 0.
import { db, audit } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import type { UserRow } from "../../_helpers";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const existing = db().prepare("SELECT id, email, name, role, disabled FROM users WHERE id = ?").get(id) as
    | UserRow
    | undefined;
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  if (existing.disabled === 0) return Response.json({ ok: true });

  db().prepare("UPDATE users SET disabled = 0 WHERE id = ?").run(id);

  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "user.access_restored",
    entity: "user",
    entityId: id,
    detail: { email: existing.email },
  });

  return Response.json({ ok: true });
}
