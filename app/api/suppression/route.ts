export const runtime = "nodejs";
// List and add suppression entries. Adding is available to any signed-in
// user (a member flagging a bounce should not need a principal); removal is
// owner-only and audited (see [email]/route.ts).
import { db, audit } from "../../lib/db";
import { requireUser } from "../../lib/session";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const rows = db()
    .prepare(`SELECT email, reason, created_at FROM suppression ORDER BY created_at DESC`)
    .all();

  return Response.json({ suppression: rows });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  let payload: { email?: string; reason?: string };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const email = (payload.email ?? "").trim().toLowerCase();
  const reason = (payload.reason ?? "").trim();
  if (!email || !email.includes("@")) {
    return Response.json({ error: "A valid email is required." }, { status: 400 });
  }
  if (!reason) {
    return Response.json({ error: "A reason is required." }, { status: 400 });
  }

  db()
    .prepare(`INSERT INTO suppression (email, reason) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET reason = excluded.reason`)
    .run(email, reason);

  audit({
    actorUserId: user.id,
    action: "suppression.add",
    entity: "suppression",
    detail: { email, reason },
  });

  return Response.json({ ok: true }, { status: 201 });
}
