export const runtime = "nodejs";

import { db, audit } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import * as v from "../../../../lib/validate";
import { TEAM_ROLES } from "../../../../lib/dealTeam";

// Deal team: many users per deal, each with a role. One route file:
// GET lists, POST adds, PATCH changes a role, DELETE ?user_id= removes.

function dealId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function list(id: number) {
  return db()
    .prepare(
      `SELECT t.user_id, u.name, t.role, t.added_at FROM deal_team t JOIN users u ON u.id = t.user_id
       WHERE t.deal_id = ? ORDER BY CASE t.role WHEN 'lead' THEN 0 ELSE 1 END, u.name`
    )
    .all(id);
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : null;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = dealId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  return Response.json({ items: list(id) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = dealId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  if (!db().prepare("SELECT id FROM deals WHERE id = ?").get(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await readBody(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });

  let userId: number, role: string;
  try {
    userId = v.integerRange("user_id", body.user_id, 1, Number.MAX_SAFE_INTEGER, { required: true })!;
    role = v.enumFromList("role", body.role, TEAM_ROLES, { fallback: "execution" })!;
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }
  if (!db().prepare("SELECT id FROM users WHERE id = ? AND disabled = 0").get(userId)) {
    return Response.json({ error: "Unknown user" }, { status: 400 });
  }
  if (db().prepare("SELECT 1 FROM deal_team WHERE deal_id = ? AND user_id = ?").get(id, userId)) {
    return Response.json({ error: "Already on the deal team" }, { status: 409 });
  }
  db().prepare("INSERT INTO deal_team (deal_id, user_id, role) VALUES (?, ?, ?)").run(id, userId, role);
  audit({ actorUserId: user.id, action: "deal.team.add", entity: "deal", entityId: id, detail: { user_id: userId, role } });
  return Response.json({ items: list(id) }, { status: 201 });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = dealId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  const body = await readBody(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  let userId: number, role: string;
  try {
    userId = v.integerRange("user_id", body.user_id, 1, Number.MAX_SAFE_INTEGER, { required: true })!;
    role = v.enumFromList("role", body.role, TEAM_ROLES, { required: true })!;
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }
  const existing = db().prepare("SELECT role FROM deal_team WHERE deal_id = ? AND user_id = ?").get(id, userId) as
    | { role: string }
    | undefined;
  if (!existing) return Response.json({ error: "Not on the deal team" }, { status: 404 });
  db().prepare("UPDATE deal_team SET role = ? WHERE deal_id = ? AND user_id = ?").run(role, id, userId);
  audit({
    actorUserId: user.id,
    action: "deal.team.role",
    entity: "deal",
    entityId: id,
    detail: { user_id: userId, from: existing.role, to: role },
  });
  return Response.json({ items: list(id) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = dealId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  const userId = Number(new URL(req.url).searchParams.get("user_id"));
  if (!Number.isInteger(userId) || userId <= 0) return Response.json({ error: "user_id is required" }, { status: 400 });
  const res = db().prepare("DELETE FROM deal_team WHERE deal_id = ? AND user_id = ?").run(id, userId);
  if (Number(res.changes) === 0) return Response.json({ error: "Not on the deal team" }, { status: 404 });
  audit({ actorUserId: user.id, action: "deal.team.remove", entity: "deal", entityId: id, detail: { user_id: userId } });
  return Response.json({ items: list(id) });
}
