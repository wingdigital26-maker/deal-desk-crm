export const runtime = "nodejs";
// Self-service password change for the signed-in user. Never logs either
// password, plaintext or hashed, anywhere including audit_log.
import { db, audit } from "../../../lib/db";
import { requireUser, verifyPassword, hashPassword } from "../../../lib/session";

const MIN_LENGTH = 12;

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword) {
    return Response.json({ error: "currentPassword is required" }, { status: 400 });
  }
  if (!newPassword || newPassword.length < MIN_LENGTH) {
    return Response.json({ error: `newPassword must be at least ${MIN_LENGTH} characters` }, { status: 400 });
  }
  if (newPassword.toLowerCase() === user.email.toLowerCase()) {
    return Response.json({ error: "newPassword must not be your email address" }, { status: 400 });
  }

  const row = db().prepare("SELECT id, password_hash FROM users WHERE id = ?").get(user.id) as
    | { id: number; password_hash: string }
    | undefined;
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    return Response.json({ error: "currentPassword is incorrect" }, { status: 400 });
  }

  const newHash = hashPassword(newPassword);
  db()
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(newHash, user.id);

  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "user.password_change",
    entity: "user",
    entityId: user.id,
    detail: {},
  });

  return Response.json({ ok: true });
}
