export const runtime = "nodejs";

import { requireUser } from "../../../lib/session";
import { documentErrorResponse, getDocumentWithVersions, updateDocument } from "../../../lib/documents";

type Ctx = { params: Promise<{ id: string }> };

const parseId = (raw: string) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// GET: this version's metadata plus every version of its document.
export async function GET(_req: Request, ctx: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  const out = getDocumentWithVersions(id);
  if (!out) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(out);
}

// PATCH { title?, note?, archived? }. Archive hides the whole document group; nothing is deleted.
// There is deliberately no DELETE handler: documents are records and are kept.
export async function PATCH(req: Request, ctx: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid JSON" }, { status: 400 });
  try {
    return Response.json({ document: updateDocument(id, body, user.id) });
  } catch (err) {
    return documentErrorResponse(err);
  }
}
