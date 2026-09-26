// Deal documents service. Routes stay thin; the 17a-4 rules live here:
//   - every upload is a new row (a new version of its doc_key), never an overwrite
//   - bytes are content-addressed on disk and never deleted (app/lib/files.ts)
//   - archive only hides a group; it is reversible and audited
//   - every upload, edit, archive and download writes an audit row
import { randomBytes } from "node:crypto";
import { db, audit } from "./db";
import * as v from "./validate";
import { putBlob, blobPath, blobSize } from "./files";
import { ALLOWED_TYPES, BUYER_KINDS, DOC_KINDS, MAX_UPLOAD_BYTES, type DocKind } from "./documentKinds";

export class DocumentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function documentErrorResponse(err: unknown): Response {
  if (err instanceof DocumentError) return Response.json({ error: err.message }, { status: err.status });
  const res = v.validationErrorResponse(err);
  if (res) return res;
  throw err;
}

export type DocumentVersion = {
  id: number;
  version: number;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  note: string | null;
  uploaded_by: number | null;
  uploaded_by_name: string | null;
  created_at: string;
};

export type DocumentRow = DocumentVersion & {
  deal_id: number;
  deal_buyer_id: number | null;
  buyer_name: string | null;
  kind: DocKind;
  title: string;
  doc_key: string;
  archived_at: string | null;
};

export type DocumentGroup = DocumentRow & { version_count: number; versions: DocumentVersion[] };

const SELECT_DOCS = `
  SELECT d.*, u.name AS uploaded_by_name, c.name AS buyer_name
  FROM documents d
  LEFT JOIN users u ON u.id = d.uploaded_by
  LEFT JOIN deal_buyers b ON b.id = d.deal_buyer_id
  LEFT JOIN companies c ON c.id = b.buyer_company_id`;

// ---- file checks ----

/** Strip paths, control and reserved characters; keep a readable name with its extension. */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let clean = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*;]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (clean.length > 150) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 ? clean.slice(dot) : "";
    clean = clean.slice(0, 150 - ext.length) + ext;
  }
  return clean || "document";
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** The canonical mime to store, or a 400 for a type we do not accept. */
export function checkFileType(filename: string, clientMime: string): string {
  const ext = extensionOf(filename);
  const allowed = ALLOWED_TYPES[ext];
  if (!allowed) {
    throw new DocumentError(`That file type is not allowed. Upload one of: ${Object.keys(ALLOWED_TYPES).join(", ")}`);
  }
  const m = (clientMime || "").split(";")[0].trim().toLowerCase();
  if (m && m !== "application/octet-stream" && !allowed.accept.includes(m)) {
    throw new DocumentError(`The file says it is ${m}, which does not match .${ext}`);
  }
  return allowed.mime;
}

// ---- reads ----

function versionsOf(docKey: string): DocumentVersion[] {
  return db()
    .prepare(
      `SELECT d.id, d.version, d.filename, d.mime, d.size, d.sha256, d.note, d.uploaded_by, d.created_at, u.name AS uploaded_by_name
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.doc_key = ? ORDER BY d.version DESC`
    )
    .all(docKey) as DocumentVersion[];
}

export function getDocument(id: number): DocumentRow | undefined {
  return db().prepare(`${SELECT_DOCS} WHERE d.id = ?`).get(id) as DocumentRow | undefined;
}

/** The latest version of every document group on a deal, with its version history. */
export function listDocuments(dealId: number, includeArchived = false): DocumentGroup[] {
  const latest = db()
    .prepare(
      `SELECT d.*, u.name AS uploaded_by_name, c.name AS buyer_name, g.version_count
       FROM documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
       LEFT JOIN deal_buyers b ON b.id = d.deal_buyer_id
       LEFT JOIN companies c ON c.id = b.buyer_company_id
       JOIN (SELECT doc_key, MAX(version) AS v, COUNT(*) AS version_count FROM documents WHERE deal_id = ? GROUP BY doc_key) g
         ON g.doc_key = d.doc_key AND g.v = d.version
       WHERE d.deal_id = ? AND (? = 1 OR d.archived_at IS NULL)
       ORDER BY d.created_at DESC, d.id DESC`
    )
    .all(dealId, dealId, includeArchived ? 1 : 0) as (DocumentRow & { version_count: number })[];
  if (latest.length === 0) return [];
  const all = db()
    .prepare(
      `SELECT d.doc_key, d.id, d.version, d.filename, d.mime, d.size, d.sha256, d.note, d.uploaded_by, d.created_at, u.name AS uploaded_by_name
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.deal_id = ? ORDER BY d.version DESC`
    )
    .all(dealId) as (DocumentVersion & { doc_key: string })[];
  const byKey = new Map<string, DocumentVersion[]>();
  for (const { doc_key, ...ver } of all) {
    if (!byKey.has(doc_key)) byKey.set(doc_key, []);
    byKey.get(doc_key)!.push(ver);
  }
  const order = (k: string) => DOC_KINDS.indexOf(k as DocKind);
  return latest
    .map((row) => ({ ...row, versions: byKey.get(row.doc_key) ?? [] }))
    .sort((a, b) => order(a.kind) - order(b.kind));
}

export function getDocumentWithVersions(id: number) {
  const doc = getDocument(id);
  if (!doc) return null;
  const versions = versionsOf(doc.doc_key);
  return { document: doc, latest_id: versions[0]?.id ?? doc.id, versions };
}

/** deal_buyer_id -> id of the latest NDA version on file, for the buyer log. */
export function latestNdaByBuyer(dealId: number): Record<number, number> {
  const rows = db()
    .prepare(
      `SELECT d.deal_buyer_id, d.id FROM documents d
       WHERE d.deal_id = ? AND d.kind = 'nda' AND d.deal_buyer_id IS NOT NULL AND d.archived_at IS NULL
       ORDER BY d.created_at ASC, d.id ASC`
    )
    .all(dealId) as { deal_buyer_id: number; id: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.deal_buyer_id] = r.id; // last one wins = newest
  return out;
}

// ---- writes ----

export type UploadInput = {
  dealId: number;
  kind: DocKind | null;
  title: string | null;
  dealBuyerId: number | null;
  docKey: string | null;
  note: string | null;
  filename: string;
  clientMime: string;
  bytes: Uint8Array;
};

function defaultKey(dealId: number, kind: DocKind, dealBuyerId: number | null): string {
  if (dealBuyerId && (BUYER_KINDS as DocKind[]).includes(kind)) return `buyer:${dealBuyerId}:${kind}`;
  if (kind === "engagement_letter" || kind === "teaser" || kind === "cim") return `deal:${dealId}:${kind}`;
  return `doc:${dealId}:${randomBytes(8).toString("hex")}`;
}

const stem = (filename: string) => {
  const dot = filename.lastIndexOf(".");
  return (dot > 0 ? filename.slice(0, dot) : filename).slice(0, 200);
};

export function uploadDocument(input: UploadInput, userId: number): DocumentRow {
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new DocumentError("Files must be 25 MB or smaller", 413);
  if (input.bytes.byteLength === 0) throw new DocumentError("That file is empty");
  const filename = sanitizeFilename(input.filename);
  const mime = checkFileType(filename, input.clientMime);

  const deal = db().prepare("SELECT id FROM deals WHERE id = ?").get(input.dealId);
  if (!deal) throw new DocumentError("Deal not found", 404);

  let kind: DocKind;
  let dealBuyerId: number | null;
  let docKey: string;
  let title: string;

  if (input.docKey) {
    // A new version of an existing document: it inherits the group's deal, kind and buyer.
    const prev = db()
      .prepare("SELECT * FROM documents WHERE doc_key = ? ORDER BY version DESC LIMIT 1")
      .get(input.docKey) as DocumentRow | undefined;
    if (!prev) throw new DocumentError("No document with that doc_key", 404);
    if (prev.deal_id !== input.dealId) throw new DocumentError("That document belongs to a different deal");
    kind = prev.kind;
    dealBuyerId = prev.deal_buyer_id;
    docKey = prev.doc_key;
    title = input.title ?? prev.title;
  } else {
    if (!input.kind) throw new v.ValidationError("kind", "kind is required");
    kind = input.kind;
    dealBuyerId = input.dealBuyerId;
    if (dealBuyerId) {
      const b = db().prepare("SELECT deal_id FROM deal_buyers WHERE id = ?").get(dealBuyerId) as { deal_id: number } | undefined;
      if (!b || b.deal_id !== input.dealId) throw new DocumentError("That buyer is not on this deal's buyer log");
    }
    docKey = defaultKey(input.dealId, kind, dealBuyerId);
    title = input.title ?? stem(filename);
  }

  const { sha256, size } = putBlob(input.bytes);

  const d = db();
  d.exec("BEGIN IMMEDIATE");
  let id: number;
  let version: number;
  try {
    const max = d.prepare("SELECT MAX(version) AS m FROM documents WHERE doc_key = ?").get(docKey) as { m: number | null };
    version = (max.m ?? 0) + 1;
    id = Number(
      d
        .prepare(
          `INSERT INTO documents (deal_id, deal_buyer_id, kind, title, doc_key, version, filename, mime, size, sha256, note, uploaded_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(input.dealId, dealBuyerId, kind, title, docKey, version, filename, mime, size, sha256, input.note, userId).lastInsertRowid
    );
    // A new version brings an archived group back into the default list.
    d.prepare("UPDATE documents SET archived_at = NULL WHERE doc_key = ? AND archived_at IS NOT NULL").run(docKey);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }

  audit({
    actorUserId: userId,
    action: "document.upload",
    entity: "document",
    entityId: id,
    detail: { deal_id: input.dealId, deal_buyer_id: dealBuyerId, kind, doc_key: docKey, version, filename, size, sha256 },
  });
  return getDocument(id)!;
}

export type DocumentPatch = { title?: unknown; note?: unknown; archived?: unknown };

export function updateDocument(id: number, patch: DocumentPatch, userId: number): DocumentRow {
  const doc = getDocument(id);
  if (!doc) throw new DocumentError("Not found", 404);
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (patch.title !== undefined) {
    const t = v.title("title", patch.title, { required: true })!;
    if (t !== doc.title) {
      db().prepare("UPDATE documents SET title = ? WHERE id = ?").run(t, id);
      changes.title = { from: doc.title, to: t };
    }
  }
  if (patch.note !== undefined) {
    const n = v.notes("note", patch.note);
    if (n !== doc.note) {
      db().prepare("UPDATE documents SET note = ? WHERE id = ?").run(n, id);
      changes.note = { from: doc.note, to: n };
    }
  }
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== "boolean") throw new v.ValidationError("archived", "archived must be true or false");
    const isArchived = doc.archived_at !== null;
    if (patch.archived !== isArchived) {
      if (patch.archived) db().prepare("UPDATE documents SET archived_at = datetime('now') WHERE doc_key = ? AND archived_at IS NULL").run(doc.doc_key);
      else db().prepare("UPDATE documents SET archived_at = NULL WHERE doc_key = ?").run(doc.doc_key);
      audit({
        actorUserId: userId,
        action: patch.archived ? "document.archive" : "document.unarchive",
        entity: "document",
        entityId: id,
        detail: { doc_key: doc.doc_key, deal_id: doc.deal_id },
      });
    }
  }
  if (Object.keys(changes).length) {
    audit({ actorUserId: userId, action: "document.update", entity: "document", entityId: id, detail: { doc_key: doc.doc_key, changes } });
  }
  return getDocument(id)!;
}

/** Where the bytes are, or null when this workspace does not have the file (demo rows). */
export function locateFile(doc: Pick<DocumentRow, "sha256">): { path: string; size: number } | null {
  const size = blobSize(doc.sha256);
  return size === null ? null : { path: blobPath(doc.sha256), size };
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 name. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
