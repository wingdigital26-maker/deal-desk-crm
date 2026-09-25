export const runtime = "nodejs";
// List + create templates. Every state change is audited.
import { db, audit } from "../../lib/db";
import { requireUser } from "../../lib/session";
import { contentHash, lintText } from "../../lib/compliance";
import { firm } from "../../../firm.config";
import type { SQLInputValue } from "node:sqlite";

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

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const segment = url.searchParams.get("segment");
  const status = url.searchParams.get("status");

  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (segment) {
    clauses.push("t.segment_id = ?");
    params.push(segment);
  }
  if (status) {
    clauses.push("t.status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db()
    .prepare(
      `SELECT t.*, u.name AS approved_by_name FROM templates t LEFT JOIN users u ON u.id = t.approved_by ${where} ORDER BY t.updated_at DESC`
    )
    .all(...params) as TemplateRow[];

  return Response.json({ templates: rows });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  let body: { name?: unknown; segmentId?: unknown; subject?: unknown; bodyText?: unknown; allowedMergeFields?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const segmentId = typeof body.segmentId === "string" ? body.segmentId : "";
  const subject = typeof body.subject === "string" ? body.subject : "";
  const bodyText = typeof body.bodyText === "string" ? body.bodyText : "";
  const allowedMergeFields = Array.isArray(body.allowedMergeFields)
    ? (body.allowedMergeFields.filter((f) => typeof f === "string") as string[])
    : [];

  if (!name) return Response.json({ error: "Name is required" }, { status: 400 });
  if (!firm.segments.some((s) => s.id === segmentId)) {
    return Response.json({ error: "Unknown segment" }, { status: 400 });
  }
  if (!subject.trim() || !bodyText.trim()) {
    return Response.json({ error: "Subject and body are required" }, { status: 400 });
  }

  const hash = contentHash(subject, bodyText, allowedMergeFields);
  const blockFindings = lintText(`${subject}\n${bodyText}`).filter((f) => f.severity === "block");
  if (blockFindings.length > 0) {
    return Response.json({ error: "Draft contains blocked content", findings: blockFindings }, { status: 400 });
  }

  const result = db()
    .prepare(
      `INSERT INTO templates (name, segment_id, subject, body, allowed_merge_fields, content_hash, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`
    )
    .run(name, segmentId, subject, bodyText, JSON.stringify(allowedMergeFields), hash, user.id);

  const id = Number(result.lastInsertRowid);
  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "template.create",
    entity: "template",
    entityId: id,
    detail: { name, segmentId, contentHash: hash },
  });

  return Response.json({ id }, { status: 201 });
}
