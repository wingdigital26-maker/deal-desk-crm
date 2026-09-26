export const runtime = "nodejs";

import { requireUser } from "../../lib/session";
import * as v from "../../lib/validate";
import { addBuyers, funnel, listBuyers, reached, buyerErrorResponse } from "../../lib/buyers";

// GET ?deal_id= : the deal's buyer log with funnel counts.
export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const dealId = Number(new URL(req.url).searchParams.get("deal_id"));
  if (!Number.isInteger(dealId) || dealId <= 0) return Response.json({ error: "deal_id is required" }, { status: 400 });
  const items = listBuyers(dealId);
  return Response.json({ items, funnel: funnel(items), reached: reached(items) });
}

// POST { deal_id, buyers: [{ buyer_company_id, lead_contact_id? }] } : add one or many.
// Duplicates are skipped and reported, never a failed batch.
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.buyers) || body.buyers.length === 0) {
    return Response.json({ error: "buyers must be a non-empty list" }, { status: 400 });
  }
  if (body.buyers.length > 500) return Response.json({ error: "Add at most 500 buyers at a time" }, { status: 400 });
  try {
    const dealId = v.integerRange("deal_id", body.deal_id, 1, Number.MAX_SAFE_INTEGER, { required: true })!;
    const items = (body.buyers as Record<string, unknown>[]).map((b, i) => ({
      buyer_company_id: v.integerRange(`buyers[${i}].buyer_company_id`, b?.buyer_company_id, 1, Number.MAX_SAFE_INTEGER, { required: true })!,
      lead_contact_id: v.integerRange(`buyers[${i}].lead_contact_id`, b?.lead_contact_id, 1, Number.MAX_SAFE_INTEGER),
    }));
    const result = addBuyers(dealId, items, user.id);
    return Response.json(result, { status: result.created.length || result.restored.length ? 201 : 200 });
  } catch (err) {
    return buyerErrorResponse(err);
  }
}
