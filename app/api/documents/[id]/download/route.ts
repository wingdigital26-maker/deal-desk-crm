export const runtime = "nodejs";

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { requireUser } from "../../../../lib/session";
import { audit } from "../../../../lib/db";
import { contentDisposition, getDocument, locateFile } from "../../../../lib/documents";

// GET: stream one stored version as an attachment. Every download is audited
// (deal documents can carry material non-public information).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid id" }, { status: 400 });

  const doc = getDocument(id);
  if (!doc) return Response.json({ error: "Not found" }, { status: 404 });
  const file = locateFile(doc);
  if (!file) return Response.json({ error: "File not available in this workspace" }, { status: 404 });

  audit({
    actorUserId: user.id,
    action: "document.download",
    entity: "document",
    entityId: doc.id,
    detail: { deal_id: doc.deal_id, doc_key: doc.doc_key, version: doc.version, filename: doc.filename, sha256: doc.sha256 },
  });

  const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": doc.mime,
      "Content-Length": String(file.size),
      "Content-Disposition": contentDisposition(doc.filename),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
