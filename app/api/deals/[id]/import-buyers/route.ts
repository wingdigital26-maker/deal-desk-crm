export const runtime = "nodejs";

import { requireUser } from "../../../../lib/session";
import { assertDeal } from "../../../../lib/dealAccess";
import * as v from "../../../../lib/validate";
import { buyerErrorResponse } from "../../../../lib/buyers";
import { importBuyers } from "../../../../lib/import4d";
import type { ImportMapping } from "../../../../lib/import4dMap";

// POST { csv, mapping, dry_run? }: a 4Degrees Deal List CSV onto this deal's
// buyer log. dry_run returns the same per-row result and writes nothing.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid id" }, { status: 400 });
  const hidden = assertDeal(user, id);
  if (hidden) return hidden;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  try {
    const csv = v.boundedString("csv", body.csv, 5_000_000, { required: true }) as string;
    const raw = body.mapping;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new v.ValidationError("mapping", "mapping is required");
    const mapping: ImportMapping = {};
    for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val === "" || val == null) continue;
      if (typeof val !== "string" || val.length > 200) throw new v.ValidationError("mapping", `mapping.${k} must be a column name`);
      (mapping as Record<string, string>)[k] = val;
    }
    const result = importBuyers(id, csv, mapping, user.id, { dryRun: body.dry_run === true });
    return Response.json(result, { status: result.dry_run ? 200 : 201 });
  } catch (err) {
    return buyerErrorResponse(err);
  }
}
