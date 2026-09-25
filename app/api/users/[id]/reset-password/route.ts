export const runtime = "nodejs";
// Reset a person's password: same one-time-reveal flow as Add a person. The
// plaintext temp password is returned once in this response and never stored
// or logged (not even in audit_log).
import { db, audit } from "../../../../lib/db";
import { requireUser, hashPassword } from "../../../../lib/session";
import { generateTempPassword, type UserRow } from "../../_helpers";

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

  const tempPassword = generateTempPassword();
  const hash = hashPassword(tempPassword);
  db().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);

  // TODO(must_change_password): once app/lib/db.ts adds users.must_change_password,
  // set it to 1 here too, so a reset password also forces a change on next sign-in.

  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "user.password_reset",
    entity: "user",
    entityId: id,
    detail: { email: existing.email },
  });

  return Response.json({ tempPassword });
}
