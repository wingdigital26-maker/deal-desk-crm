export const runtime = "nodejs";

import { requireUser } from "../../../lib/session";
import { buyerCandidates, resolveCompanies } from "../../../lib/buyers";

// GET ?deal_id=&q= : companies to offer in the bulk-add picker.
export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const dealId = Number(url.searchParams.get("deal_id"));
  if (!Number.isInteger(dealId) || dealId <= 0) return Response.json({ error: "deal_id is required" }, { status: 400 });
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  return Response.json({ items: buyerCandidates(dealId, q) });
}

// POST { rows: [{ name, domain }] } : match pasted CSV rows to existing companies.
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.rows) || body.rows.length > 1000) {
    return Response.json({ error: "rows must be a list of up to 1000 { name, domain }" }, { status: 400 });
  }
  const rows = (body.rows as unknown[]).map((r) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    return { name: typeof o.name === "string" ? o.name.slice(0, 200) : "", domain: typeof o.domain === "string" ? o.domain.slice(0, 200) : "" };
  });
  return Response.json({ items: resolveCompanies(rows) });
}
