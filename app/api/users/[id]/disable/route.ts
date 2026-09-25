export const runtime = "nodejs";
// Remove access: sets disabled = 1 (never a hard delete). session.ts already
// checks `disabled` on every request, so this signs the person out on their
// next request.
import { db, audit } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import { countActiveOwners, type UserRow } from "../../_helpers";

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

  if (id === user.id) {
    return Response.json(
      { error: "You cannot remove your own access. Have another owner do this." },
      { status: 400 }
    );
  }

  if (existing.role === "owner" && existing.disabled === 0 && countActiveOwners(id) === 0) {
    return Response.json(
      { error: "The workspace must always keep at least one active owner. Make someone else an owner first." },
      { status: 400 }
    );
  }

  if (existing.disabled === 1) return Response.json({ ok: true });

  db().prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(id);

  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "user.access_removed",
    entity: "user",
    entityId: id,
    detail: { email: existing.email },
  });

  return Response.json({ ok: true });
}
