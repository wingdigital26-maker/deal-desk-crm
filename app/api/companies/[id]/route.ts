export const runtime = "nodejs";
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import { firm } from "../../../../firm.config";
import { normalizeDomain } from "../route";
import * as v from "../../../lib/validate";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const row = db().prepare("SELECT * FROM companies WHERE id = ?").get(Number(id));
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ row });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const companyId = Number(id);
  const existing = db().prepare("SELECT * FROM companies WHERE id = ?").get(companyId);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Invalid body" }, { status: 400 });

  const fields: Record<string, string | number | null> = {};
  try {
    if ("name" in body) {
      fields.name = v.name("name", body.name, { required: true })!;
    }
    if ("domain" in body) {
      const domain = typeof body.domain === "string" && body.domain.trim() ? normalizeDomain(body.domain) : null;
      if (domain) {
        const dupe = db().prepare("SELECT id FROM companies WHERE domain = ? AND id != ?").get(domain, companyId) as
          | { id: number }
          | undefined;
        if (dupe) return Response.json({ error: "Another company already uses this domain" }, { status: 409 });
      }
      fields.domain = domain;
    }
    if ("segment_id" in body) {
      const ids = firm.segments.map((s) => s.id);
      fields.segment_id = ids.includes(body.segment_id) ? body.segment_id : ids[0];
    }
    if ("industry" in body) fields.industry = v.boundedString("industry", body.industry, 200);
    if ("city" in body) fields.city = v.boundedString("city", body.city, 200);
    if ("state" in body) fields.state = v.boundedString("state", body.state, 200);
    if ("revenue_band" in body) fields.revenue_band = v.boundedString("revenue_band", body.revenue_band, 200);
    if ("notes" in body) fields.notes = v.notes("notes", body.notes);
    if ("employees" in body) fields.employees = v.employees("employees", body.employees);
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }

  if (Object.keys(fields).length === 0) return Response.json({ error: "Nothing to update" }, { status: 400 });

  const setSql = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(", ");
  db()
    .prepare(`UPDATE companies SET ${setSql}, updated_at = datetime('now') WHERE id = ?`)
    .run(...Object.values(fields), companyId);

  audit({ actorUserId: user.id, actorLabel: user.email, action: "company.update", entity: "company", entityId: companyId, detail: fields });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;
  const { id } = await params;
  const companyId = Number(id);
  const existing = db().prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId) as
    | { id: number; name: string }
    | undefined;
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });
  db().prepare("DELETE FROM companies WHERE id = ?").run(companyId);
  audit({ actorUserId: user.id, actorLabel: user.email, action: "company.delete", entity: "company", entityId: companyId, detail: { name: existing.name } });
  return Response.json({ ok: true });
}
