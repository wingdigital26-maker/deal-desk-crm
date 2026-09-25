export const runtime = "nodejs";
import { db, audit } from "../../lib/db";
import { requireUser } from "../../lib/session";

const KINDS = ["note", "call", "email-out", "email-in", "stage-change", "signal", "import"];

// GET ?company_id= or ?contact_id= or ?deal_id= -> timeline rows, newest first.
export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const companyId = url.searchParams.get("company_id");
  const contactId = url.searchParams.get("contact_id");
  const dealId = url.searchParams.get("deal_id");
  if (!companyId && !contactId && !dealId) {
    return Response.json({ error: "company_id, contact_id or deal_id is required" }, { status: 400 });
  }

  const where: string[] = [];
  const params: number[] = [];
  if (companyId) {
    where.push("activities.company_id = ?");
    params.push(Number(companyId));
  }
  if (contactId) {
    where.push("activities.contact_id = ?");
    params.push(Number(contactId));
  }
  if (dealId) {
    where.push("activities.deal_id = ?");
    params.push(Number(dealId));
  }

  const rows = db()
    .prepare(
      `SELECT activities.*, users.name AS user_name FROM activities
       LEFT JOIN users ON users.id = activities.user_id
       WHERE ${where.join(" OR ")} ORDER BY activities.created_at DESC, activities.id DESC`
    )
    .all(...params);

  return Response.json({ rows });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const body = await req.json().catch(() => null);
  if (!body || typeof body.kind !== "string" || !KINDS.includes(body.kind)) {
    return Response.json({ error: "A valid activity kind is required" }, { status: 400 });
  }
  const companyId = body.company_id != null ? Number(body.company_id) : null;
  const contactId = body.contact_id != null ? Number(body.contact_id) : null;
  const dealId = body.deal_id != null ? Number(body.deal_id) : null;
  if (!companyId && !contactId && !dealId) {
    return Response.json({ error: "An activity must be attached to a company, contact or deal" }, { status: 400 });
  }
  const activityBody = typeof body.body === "string" && body.body.trim() ? body.body.trim() : null;
  if (body.kind === "note" && !activityBody) {
    return Response.json({ error: "A note needs text" }, { status: 400 });
  }

  const result = db()
    .prepare(
      `INSERT INTO activities (kind, body, company_id, contact_id, deal_id, user_id) VALUES (?,?,?,?,?,?)`
    )
    .run(body.kind, activityBody, companyId, contactId, dealId, user.id);
  const id = Number(result.lastInsertRowid);
  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: "activity.create",
    entity: "activity",
    entityId: id,
    detail: { kind: body.kind, company_id: companyId, contact_id: contactId, deal_id: dealId },
  });
  return Response.json({ id }, { status: 201 });
}
