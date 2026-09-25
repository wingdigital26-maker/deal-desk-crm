export const runtime = "nodejs";
// Submit a draft template for approval. Disabled (server-enforced) while any
// block-severity lint finding exists. Snapshots the full content into the
// audit row so the approvals screen can diff against it later.
import { db, audit } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import { lintText } from "../../../../lib/compliance";

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
  const user = await requireUser();
  if (user instanceof Response) return user;

  const { id: raw } = await ctx.params;
  const id = parseId(raw);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const row = db().prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined;
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  if (row.status !== "draft" && row.status !== "rejected") {
    return Response.json({ error: `Cannot submit a template with status "${row.status}"` }, { status: 409 });
  }

  const findings = lintText(`${row.subject}\n${row.body}`);
  const blockFindings = findings.filter((f) => f.severity === "block");
  if (blockFindings.length > 0) {
    return Response.json({ error: "Cannot submit while blocked findings exist", findings: blockFindings }, { status: 409 });
  }

  db()
    .prepare("UPDATE templates SET status = 'pending', updated_at = datetime('now') WHERE id = ?")
    .run(id);

  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "template.submit",
    entity: "template",
    entityId: id,
    detail: {
      subject: row.subject,
      body: row.body,
      allowedMergeFields: JSON.parse(row.allowed_merge_fields),
      contentHash: row.content_hash,
      findings,
    },
  });

  return Response.json({ ok: true });
}
