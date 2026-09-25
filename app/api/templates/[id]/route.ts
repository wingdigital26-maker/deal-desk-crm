export const runtime = "nodejs";
// Get or edit a single template. Any edit recomputes the hash and voids approval.
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import { contentHash, lintText } from "../../../lib/compliance";

type TemplateRow = {
  id: number;
  name: string;
  segment_id: string;
  subject: string;
  body: string;
  allowed_merge_fields: string;
  content_hash: string;
  status: string;
  approved_by: number | null;
  approved_at: string | null;
  review_note: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
};

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const { id: raw } = await ctx.params;
  const id = parseId(raw);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const row = db().prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined;
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });

  return Response.json({ template: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const { id: raw } = await ctx.params;
  const id = parseId(raw);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const existing = db().prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined;
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });
  if (existing.status === "retired") {
    return Response.json({ error: "Retired templates cannot be edited" }, { status: 409 });
  }

  let body: { name?: unknown; subject?: unknown; bodyText?: unknown; allowedMergeFields?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name;
  const subject = typeof body.subject === "string" ? body.subject : existing.subject;
  const bodyText = typeof body.bodyText === "string" ? body.bodyText : existing.body;
  const allowedMergeFields = Array.isArray(body.allowedMergeFields)
    ? (body.allowedMergeFields.filter((f) => typeof f === "string") as string[])
    : (JSON.parse(existing.allowed_merge_fields) as string[]);

  if (!subject.trim() || !bodyText.trim()) {
    return Response.json({ error: "Subject and body are required" }, { status: 400 });
  }

  const newHash = contentHash(subject, bodyText, allowedMergeFields);
  // Every edit voids approval and resets to draft, per the compliance model.
  db()
    .prepare(
      `UPDATE templates SET name = ?, subject = ?, body = ?, allowed_merge_fields = ?, content_hash = ?,
       status = 'draft', approved_by = NULL, approved_at = NULL, review_note = NULL, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(name, subject, bodyText, JSON.stringify(allowedMergeFields), newHash, id);

  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "template.edit",
    entity: "template",
    entityId: id,
    detail: {
      previousHash: existing.content_hash,
      newHash,
      previousStatus: existing.status,
      voided: existing.status === "approved" || existing.status === "pending",
    },
  });

  const findings = lintText(`${subject}\n${bodyText}`);
  return Response.json({ ok: true, contentHash: newHash, findings });
}
