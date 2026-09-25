export const runtime = "nodejs";
// Change a person's role. Owner-only. Safety rails: nobody can demote
// themselves out of Owner, and the workspace must always keep at least one
// active Owner.
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import type { Role } from "../../../lib/session";
import * as v from "../../../lib/validate";
import { countActiveOwners, ROLE_LABEL, type UserRow } from "../_helpers";

const ROLES: Role[] = ["owner", "principal", "member"];

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const existing = db().prepare("SELECT id, email, name, role, disabled FROM users WHERE id = ?").get(id) as
    | UserRow
    | undefined;
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || !("role" in body)) return Response.json({ error: "role is required" }, { status: 400 });

  let role: Role;
  try {
    role = v.enumFromList("role", body.role, ROLES, { required: true })!;
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }

  if (role === existing.role) {
    return Response.json({ ok: true });
  }

  const isSelf = id === user.id;
  const wasOwner = existing.role === "owner";
  const willStillBeOwner = role === "owner";

  if (isSelf && wasOwner && !willStillBeOwner) {
    return Response.json(
      { error: "You cannot demote yourself out of Owner. Have another owner make this change." },
      { status: 400 }
    );
  }

  if (wasOwner && !willStillBeOwner && countActiveOwners() <= 1 && existing.disabled === 0) {
    return Response.json(
      { error: "The workspace must always keep at least one active owner. Make someone else an owner first." },
      { status: 400 }
    );
  }

  db().prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);

  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "user.role_change",
    entity: "user",
    entityId: id,
    detail: { from_role: existing.role, to_role: role },
  });

  return Response.json({ ok: true, role, roleLabel: ROLE_LABEL[role] });
}
