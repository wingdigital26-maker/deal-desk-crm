export const runtime = "nodejs";

import { requireUser } from "../../../lib/session";
import { promoteCompanyToDeal } from "../../../lib/signals/queries";

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const companyId = Number(body.company_id);
  if (!companyId || Number.isNaN(companyId)) {
    return Response.json({ error: "company_id is required" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title : undefined;
  const primaryContactId =
    typeof body.primary_contact_id === "number" ? body.primary_contact_id : null;

  const result = promoteCompanyToDeal(companyId, user.id, { title, primaryContactId });
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({ deal_id: result.dealId }, { status: 201 });
}
