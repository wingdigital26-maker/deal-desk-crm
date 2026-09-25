export const runtime = "nodejs";
// Approve a pending template. Principal only. Separation of duties: the
// submitter (created_by) cannot approve their own template. Owner can reject
// but not approve - enforced by the role list below.
import { db, audit } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import { contentHash } from "../../../../lib/compliance";

type TemplateRow = {
  id: number;
  subject: string;
  body: string;
  allowed_merge_fields: string;
  content_hash: string;
  status: string;
  created_by: number | null;
};

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["principal"]);
  if (user instanceof Response) return user;

  const { id: raw } = await ctx.params;
  const id = parseId(raw);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const row = db().prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined;
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  if (row.status !== "pending") {
    return Response.json({ error: `Cannot approve a template with status "${row.status}"` }, { status: 409 });
  }
  if (row.created_by === user.id) {
    audit({
      actorUserId: user.id,
      actorLabel: user.email,
      action: "template.approve.blocked_self",
      entity: "template",
      entityId: id,
      detail: { reason: "submitter cannot approve own template" },
    });
    return Response.json({ error: "You submitted this template. A different principal must approve it." }, { status: 403 });
  }

  const fields = JSON.parse(row.allowed_merge_fields) as string[];
  const recomputed = contentHash(row.subject, row.body, fields);
  if (recomputed !== row.content_hash) {
    return Response.json({ error: "Content hash mismatch. Cannot approve." }, { status: 409 });
  }

  db()
    .prepare(
      `UPDATE templates SET status = 'approved', approved_by = ?, approved_at = datetime('now'),
       review_note = NULL, updated_at = datetime('now') WHERE id = ?`
    )
    .run(user.id, id);

  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "template.approve",
    entity: "template",
    entityId: id,
    detail: {
      subject: row.subject,
      body: row.body,
      allowedMergeFields: fields,
      contentHash: row.content_hash,
      approvedBy: user.id,
    },
  });

  return Response.json({ ok: true });
}
