export const runtime = "nodejs";

import { requireUser } from "../../lib/session";
import * as v from "../../lib/validate";
import { documentErrorResponse, listDocuments, uploadDocument } from "../../lib/documents";
import { DOC_KINDS, MAX_UPLOAD_BYTES } from "../../lib/documentKinds";

// Multipart framing (boundaries, part headers, the small text fields) on top of the file itself.
const FORM_OVERHEAD = 64 * 1024;

// GET ?deal_id=&include_archived=1 : latest version per document, with version count and history.
export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const sp = new URL(req.url).searchParams;
  const dealId = Number(sp.get("deal_id"));
  if (!Number.isInteger(dealId) || dealId <= 0) return Response.json({ error: "deal_id is required" }, { status: 400 });
  return Response.json({ items: listDocuments(dealId, sp.get("include_archived") === "1") });
}

// POST multipart/form-data: file, deal_id, kind, title?, deal_buyer_id?, doc_key? (new version), note?
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  // Refuse an oversized upload from its declared length, before reading the body.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + FORM_OVERHEAD) {
    return Response.json({ error: "Files must be 25 MB or smaller" }, { status: 413 });
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return Response.json({ error: "Send the file as multipart/form-data" }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Could not read the upload" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return Response.json({ error: "file is required", field: "file" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "Files must be 25 MB or smaller" }, { status: 413 });

  const field = (k: string) => {
    const val = form.get(k);
    return typeof val === "string" ? val : null;
  };
  try {
    const dealId = v.integerRange("deal_id", field("deal_id"), 1, Number.MAX_SAFE_INTEGER, { required: true })!;
    const docKey = v.boundedString("doc_key", field("doc_key"), 100);
    const doc = uploadDocument(
      {
        dealId,
        docKey,
        kind: v.enumFromList("kind", field("kind"), DOC_KINDS, { required: !docKey }),
        title: v.title("title", field("title")),
        dealBuyerId: v.integerRange("deal_buyer_id", field("deal_buyer_id"), 1, Number.MAX_SAFE_INTEGER),
        note: v.notes("note", field("note")),
        filename: file.name || "document",
        clientMime: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      },
      user.id
    );
    return Response.json({ document: doc }, { status: 201 });
  } catch (err) {
    return documentErrorResponse(err);
  }
}
