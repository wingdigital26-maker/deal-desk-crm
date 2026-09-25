export const runtime = "nodejs";

import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import * as v from "../../../lib/validate";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const task = db().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!task) return Response.json({ error: "Not found" }, { status: 404 });

  return Response.json({ item: task });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const existing = db().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  const detail: Record<string, unknown> = {};

  try {
    if ("title" in body) {
      fields.push("title = ?");
      values.push(v.title("title", body.title, { required: true })!);
    }
    if ("due" in body) {
      fields.push("due = ?");
      values.push(v.isoDate("due", body.due));
    }
    if ("done" in body) {
      fields.push("done = ?");
      values.push(body.done ? 1 : 0);
      detail.done = Boolean(body.done);
    }
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }

  if (fields.length === 0) {
    return Response.json({ error: "No valid fields to update" }, { status: 400 });
  }

  values.push(id);
  db()
    .prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number | null)[]));

  audit({ actorUserId: user.id, action: "task.update", entity: "task", entityId: id, detail });

  const updated = db().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return Response.json({ item: updated });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const existing = db().prepare("SELECT id FROM tasks WHERE id = ?").get(id);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  db().prepare("DELETE FROM tasks WHERE id = ?").run(id);
  audit({ actorUserId: user.id, action: "task.delete", entity: "task", entityId: id });

  return Response.json({ ok: true });
}
