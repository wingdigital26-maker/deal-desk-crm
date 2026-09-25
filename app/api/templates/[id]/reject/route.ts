export const runtime = "nodejs";
// Reject a pending template. Owner or principal. A note is required.
import { db, audit } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";

type TemplateRow = { id: number; status: string };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner", "principal"]);
  if (user instanceof Response) return user;

  const { id: raw } = await ctx.params;
  const id = parseId(raw);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const row = db().prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined;
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  if (row.status !== "pending") {
    return Response.json({ error: `Cannot reject a template with status "${row.status}"` }, { status: 409 });
  }

  let body: { note?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return Response.json({ error: "A rejection note is required" }, { status: 400 });

  db()
    .prepare(
      `UPDATE templates SET status = 'rejected', review_note = ?, approved_by = NULL, approved_at = NULL,
       updated_at = datetime('now') WHERE id = ?`
    )
    .run(note, id);

  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "template.reject",
    entity: "template",
    entityId: id,
    detail: { note },
  });

  return Response.json({ ok: true });
}
