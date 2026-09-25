export const runtime = "nodejs";
// People and access: owner-only. List users (with last sign-in) and create a
// new person with a one-time temporary password that is never stored or
// logged in plaintext.
import { db, audit } from "../../lib/db";
import { requireUser, hashPassword } from "../../lib/session";
import type { Role } from "../../lib/session";
import * as v from "../../lib/validate";
import { generateTempPassword, hasActiveCompliancePrincipal, type UserRow } from "./_helpers";

const ROLES: Role[] = ["owner", "principal", "member"];

export async function GET() {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  const rows = db()
    .prepare("SELECT id, email, name, role, disabled FROM users ORDER BY name ASC")
    .all() as UserRow[];

  const lastLogins = db()
    .prepare(
      `SELECT actor_user_id AS user_id, MAX(created_at) AS at
       FROM audit_log WHERE action = 'login.success' AND actor_user_id IS NOT NULL
       GROUP BY actor_user_id`
    )
    .all() as { user_id: number; at: string }[];
  const lastLoginByUser = new Map(lastLogins.map((r) => [r.user_id, r.at]));

  const items = rows.map((r) => ({ ...r, last_login_at: lastLoginByUser.get(r.id) ?? null }));

  return Response.json({
    items,
    warnings: {
      noCompliancePrincipal: !hasActiveCompliancePrincipal(),
    },
  });
}

export async function POST(req: Request) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Invalid body" }, { status: 400 });

  let name: string, role: Role;
  try {
    name = v.name("name", body.name, { required: true })!;
    role = v.enumFromList("role", body.role, ROLES, { required: true })!;
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const emailRaw = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!emailRaw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
    return Response.json({ error: "email must be a valid email address", field: "email" }, { status: 400 });
  }
  const email = emailRaw;

  const existing = db().prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: number } | undefined;
  if (existing) {
    return Response.json({ error: "A person with this email already exists", field: "email" }, { status: 409 });
  }

  const tempPassword = generateTempPassword();
  const hash = hashPassword(tempPassword);

  const result = db()
    .prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)")
    .run(email, name, role, hash);
  const id = Number(result.lastInsertRowid);

  // TODO(must_change_password): once app/lib/db.ts adds users.must_change_password,
  // set it to 1 here so the login route forces a password-change screen on first
  // sign-in. Blocked on the shared-file owner; see final report.

  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "user.create",
    entity: "user",
    entityId: id,
    detail: { email, role },
  });

  return Response.json({ id, email, name, role, tempPassword }, { status: 201 });
}
