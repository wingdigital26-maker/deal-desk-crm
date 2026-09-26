export const runtime = "nodejs";

import { requireUser } from "../../../lib/session";
import { isBuyerStage } from "../../../lib/buyerStages";
import { buyerErrorResponse, changeStage } from "../../../lib/buyers";

// POST { ids, stage, decline_reason? } : one transaction, one audit row.
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const body = await req.json().catch(() => null);
  const ids: number[] = Array.isArray(body?.ids) ? body.ids.map(Number) : [];
  if (!ids.length || ids.length > 500 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    return Response.json({ error: "ids must be a list of buyer ids" }, { status: 400 });
  }
  if (!isBuyerStage(body.stage)) return Response.json({ error: "Invalid stage", field: "stage" }, { status: 400 });
  const reason = typeof body.decline_reason === "string" && body.decline_reason.trim() ? body.decline_reason.trim().slice(0, 500) : null;
  if (body.stage === "declined" && !reason) {
    return Response.json({ error: "A reason is required to mark buyers declined", field: "decline_reason" }, { status: 400 });
  }
  try {
    const moved = changeStage(ids, body.stage, { reason, userId: user.id });
    return Response.json({ moved });
  } catch (err) {
    return buyerErrorResponse(err);
  }
}
