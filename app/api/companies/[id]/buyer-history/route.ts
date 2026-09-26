export const runtime = "nodejs";

import { db } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import { buyerHistory } from "../../../../lib/buyers";

// Cross-deal buyer memory: every process this company was shown, newest first.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid id" }, { status: 400 });
  const profile = db().prepare("SELECT * FROM buyer_profiles WHERE company_id = ?").get(id) ?? null;
  return Response.json({ items: buyerHistory(id), profile });
}
