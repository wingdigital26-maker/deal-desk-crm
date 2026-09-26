export const runtime = "nodejs";

import { requireUser } from "../../../lib/session";
import { isBuyerStage } from "../../../lib/buyerStages";
import { buyerErrorResponse, changeStage, getBuyer, parseTermPatch, removeBuyer, updateTerms } from "../../../lib/buyers";

function parseId(raw: string) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// PATCH: stage and/or terms. A move to declined needs decline_reason
// (in this request or already on the row).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  try {
    const { stage, decline_reason, note, ...rest } = body as Record<string, unknown>;
    if (stage !== undefined && !isBuyerStage(stage)) return Response.json({ error: "Invalid stage", field: "stage" }, { status: 400 });
    const reason = typeof decline_reason === "string" && decline_reason.trim() ? decline_reason.trim().slice(0, 500) : null;
    const terms = parseTermPatch(rest);
    if (!stage && !reason && !Object.keys(terms).length) return Response.json({ error: "Nothing to update" }, { status: 400 });
    if (stage) {
      changeStage([id], stage, { reason, note: typeof note === "string" ? note.slice(0, 500) : null, userId: user.id });
    } else if (reason) {
      terms.decline_reason = reason;
    }
    if (Object.keys(terms).length) updateTerms(id, terms, user.id);
    return Response.json({ item: getBuyer(id) });
  } catch (err) {
    return buyerErrorResponse(err);
  }
}

// DELETE: soft-remove from the log. History and revisions stay.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  try {
    removeBuyer(id, user.id);
    return Response.json({ ok: true });
  } catch (err) {
    return buyerErrorResponse(err);
  }
}
