export const runtime = "nodejs";

import { db, audit } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import * as v from "../../../../lib/validate";
import { BUYER_TYPES } from "../../../../lib/buyerStages";

const MONEY = ["check_size_low", "check_size_high", "ebitda_fit_low", "ebitda_fit_high"] as const;

// PATCH: upsert the 1:1 buyer profile. Only the keys sent are changed.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid id" }, { status: 400 });
  if (!db().prepare("SELECT id FROM companies WHERE id = ?").get(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid JSON body" }, { status: 400 });

  const fields: Record<string, string | number | null> = {};
  try {
    if ("buyer_type" in body) fields.buyer_type = v.enumFromList("buyer_type", body.buyer_type, BUYER_TYPES, { required: true });
    for (const k of MONEY) if (k in body) fields[k] = v.money(k, body[k]);
    if ("thesis" in body) fields.thesis = v.boundedString("thesis", body.thesis, 2000);
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }
  if (!Object.keys(fields).length) return Response.json({ error: "Nothing to update" }, { status: 400 });

  const d = db();
  const existing = d.prepare("SELECT * FROM buyer_profiles WHERE company_id = ?").get(id) as Record<string, unknown> | undefined;
  const merged = { buyer_type: "strategic", ...(existing ?? {}), ...fields } as Record<string, string | number | null>;
  for (const [lo, hi] of [
    ["check_size_low", "check_size_high"],
    ["ebitda_fit_low", "ebitda_fit_high"],
  ]) {
    if (merged[lo] != null && merged[hi] != null && Number(merged[lo]) > Number(merged[hi])) {
      return Response.json({ error: `${lo} cannot be above ${hi}`, field: lo }, { status: 400 });
    }
  }
  const cols = ["buyer_type", ...MONEY, "thesis"];
  d.prepare(
    `INSERT INTO buyer_profiles (company_id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})
     ON CONFLICT(company_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = datetime('now')`
  ).run(id, ...cols.map((c) => merged[c] ?? null));
  audit({ actorUserId: user.id, action: "buyer_profile.upsert", entity: "company", entityId: id, detail: { fields: Object.keys(fields), before: existing ?? null } });
  return Response.json({ profile: d.prepare("SELECT * FROM buyer_profiles WHERE company_id = ?").get(id) });
}
