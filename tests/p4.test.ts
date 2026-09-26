// P4 DOCUMENTS: versioned, audited, never-deleted deal documents (BUILD-PLAN 4.1 to 4.3).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { cookieMock, freshApp, params, jsonReq, cleanup, harness, type App } from "./_harness";

vi.mock("next/headers", () => cookieMock());

let app: App;
let list: typeof import("../app/api/documents/route");
let one: typeof import("../app/api/documents/[id]/route");
let dl: typeof import("../app/api/documents/[id]/download/route");
let docs: typeof import("../app/lib/documents");

beforeEach(async () => {
  vi.resetModules();
  app = await freshApp();
  list = await import("../app/api/documents/route");
  one = await import("../app/api/documents/[id]/route");
  dl = await import("../app/api/documents/[id]/download/route");
  docs = await import("../app/lib/documents");
});
afterEach(cleanup);

const PDF = "application/pdf";

function upload(fields: Record<string, string | number>, file?: { name: string; body: Uint8Array<ArrayBuffer> | string; type?: string }, headers: Record<string, string> = {}) {
  const form = new FormData();
  if (file) form.set("file", new File([file.body], file.name, { type: file.type ?? PDF }));
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  return list.POST(new Request("http://test/api/documents", { method: "POST", body: form, headers }));
}
const download = (id: number) => dl.GET(new Request(`http://test/api/documents/${id}/download`), params(id));
const auditCount = (action: string) => (app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = ?").get(action) as { n: number }).n;
const docCount = () => (app.db.prepare("SELECT COUNT(*) n FROM documents").get() as { n: number }).n;

function filesOnDisk(): string[] {
  const dir = process.env.HARNESS_FILES_DIR!;
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

async function setup() {
  const userId = await app.signIn();
  const dealId = app.deal(app.company("Seller Co"));
  return { userId, dealId };
}

describe("4.1 storage and versions", () => {
  it("second upload to the same doc_key is v2 and v1 still downloads byte-identical", async () => {
    const { dealId } = await setup();
    const r1 = await upload({ deal_id: dealId, kind: "cim", title: "CIM" }, { name: "cim-v1.pdf", body: "%PDF-1 first draft" });
    expect(r1.status).toBe(201);
    const v1 = (await r1.json()).document;
    expect(v1.version).toBe(1);
    expect(v1.doc_key).toBe(`deal:${dealId}:cim`);

    const r2 = await upload({ deal_id: dealId, doc_key: v1.doc_key }, { name: "cim-v2.pdf", body: "%PDF-1 second draft, longer" });
    expect(r2.status).toBe(201);
    const v2 = (await r2.json()).document;
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);
    expect(v2.title).toBe("CIM");

    const d1 = await download(v1.id);
    expect(d1.status).toBe(200);
    expect(Buffer.from(await d1.arrayBuffer()).toString()).toBe("%PDF-1 first draft");
    const d2 = await download(v2.id);
    expect(Buffer.from(await d2.arrayBuffer()).toString()).toBe("%PDF-1 second draft, longer");

    // Listing shows the latest version with the count and full history.
    const listed = (await (await list.GET(jsonReq(`/api/documents?deal_id=${dealId}`, "GET"))).json()).items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: v2.id, version: 2, version_count: 2 });
    expect(listed[0].versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    const meta = await (await one.GET(jsonReq(`/api/documents/${v1.id}`, "GET"), params(v1.id))).json();
    expect(meta.document.id).toBe(v1.id);
    expect(meta.latest_id).toBe(v2.id);
    expect(meta.versions).toHaveLength(2);
  });

  it("files are content-addressed under <sha[0:2]>/<sha> and identical bytes are stored once", async () => {
    const { dealId } = await setup();
    const a = (await (await upload({ deal_id: dealId, kind: "teaser" }, { name: "teaser.pdf", body: "same bytes" })).json()).document;
    const b = (await (await upload({ deal_id: dealId, kind: "other" }, { name: "copy.pdf", body: "same bytes" })).json()).document;
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    const expected = path.join(process.env.HARNESS_FILES_DIR!, a.sha256.slice(0, 2), a.sha256);
    expect(readFileSync(expected, "utf8")).toBe("same bytes");
    expect(filesOnDisk()).toEqual([expected]);
  });

  it("the table refuses DELETE and refuses rewriting a stored version", async () => {
    const { dealId } = await setup();
    const doc = (await (await upload({ deal_id: dealId, kind: "cim" }, { name: "c.pdf", body: "x" })).json()).document;
    expect(() => app.db.prepare("DELETE FROM documents WHERE id = ?").run(doc.id)).toThrow(/never deleted/);
    expect(() => app.db.prepare("UPDATE documents SET sha256 = ? WHERE id = ?").run("0".repeat(64), doc.id)).toThrow(/cannot be rewritten/);
    expect(() => app.db.prepare("INSERT INTO documents (deal_id, kind, title, doc_key, version, filename, mime, size, sha256) VALUES (?,?,?,?,?,?,?,?,?)").run(dealId, "cim", "t", doc.doc_key, 1, "f", PDF, 1, doc.sha256)).toThrow(/UNIQUE/);
  });
});

describe("4.2 upload limits and checks", () => {
  it("rejects a file over 25 MB with 413", async () => {
    const { dealId } = await setup();
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    const res = await upload({ deal_id: dealId, kind: "financials" }, { name: "big.pdf", body: big });
    expect(res.status).toBe(413);
    expect(docCount()).toBe(0);
    expect(filesOnDisk()).toHaveLength(0);
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const { dealId } = await setup();
    const res = await upload({ deal_id: dealId, kind: "cim" }, { name: "a.pdf", body: "x" }, { "content-length": String(40 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it("rejects .exe and a mime that does not match the extension", async () => {
    const { dealId } = await setup();
    const exe = await upload({ deal_id: dealId, kind: "other" }, { name: "setup.exe", body: "MZ", type: "application/x-msdownload" });
    expect(exe.status).toBe(400);
    expect((await exe.json()).error).toMatch(/not allowed/);
    const html = await upload({ deal_id: dealId, kind: "other" }, { name: "page.pdf", body: "<html>", type: "text/html" });
    expect(html.status).toBe(400);
    expect(docCount()).toBe(0);
  });

  it("stores the canonical mime and a sanitized filename", async () => {
    const { dealId } = await setup();
    const res = await upload({ deal_id: dealId, kind: "financials" }, { name: '..\\..\\evil/"Q3 P&L".XLSX', body: "PK", type: "application/octet-stream" });
    expect(res.status).toBe(201);
    const doc = (await res.json()).document;
    expect(doc.filename).toBe("Q3 P&L.XLSX");
    expect(doc.mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(docs.sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(docs.sanitizeFilename("...")).toBe("document");
  });

  it("a buyer NDA must belong to the deal", async () => {
    const { dealId } = await setup();
    const otherDeal = app.deal(app.company("Other Seller"));
    const buyerCo = app.company("Buyer Co");
    const mine = app.insert("deal_buyers", { deal_id: dealId, buyer_company_id: buyerCo });
    const theirs = app.insert("deal_buyers", { deal_id: otherDeal, buyer_company_id: buyerCo });

    const bad = await upload({ deal_id: dealId, kind: "nda", deal_buyer_id: theirs }, { name: "nda.pdf", body: "nda" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/not on this deal/);

    const ok = await upload({ deal_id: dealId, kind: "nda", deal_buyer_id: mine }, { name: "nda.pdf", body: "nda" });
    expect(ok.status).toBe(201);
    const doc = (await ok.json()).document;
    expect(doc.doc_key).toBe(`buyer:${mine}:nda`);
    expect(doc.buyer_name).toBe("Buyer Co");

    // A version upload cannot move a document to another deal.
    const cross = await upload({ deal_id: otherDeal, doc_key: doc.doc_key }, { name: "nda2.pdf", body: "nda2" });
    expect(cross.status).toBe(400);
  });

  it("unknown deal is 404, missing kind is 400, missing file is 400", async () => {
    const { dealId } = await setup();
    expect((await upload({ deal_id: 99999, kind: "cim" }, { name: "a.pdf", body: "x" })).status).toBe(404);
    expect((await upload({ deal_id: dealId }, { name: "a.pdf", body: "x" })).status).toBe(400);
    expect((await upload({ deal_id: dealId, kind: "cim" })).status).toBe(400);
    expect((await upload({ deal_id: dealId, kind: "made_up" }, { name: "a.pdf", body: "x" })).status).toBe(400);
  });
});

describe("4.2 audit trail", () => {
  it("one audit row per upload and per download", async () => {
    const { dealId, userId } = await setup();
    const doc = (await (await upload({ deal_id: dealId, kind: "engagement_letter" }, { name: "el.pdf", body: "signed" })).json()).document;
    await upload({ deal_id: dealId, doc_key: doc.doc_key }, { name: "el2.pdf", body: "countersigned" });
    expect(auditCount("document.upload")).toBe(2);
    expect(auditCount("document.download")).toBe(0);
    await download(doc.id);
    await download(doc.id);
    expect(auditCount("document.download")).toBe(2);
    const row = app.db.prepare("SELECT actor_user_id, entity_id, detail_json FROM audit_log WHERE action = 'document.download' LIMIT 1").get() as {
      actor_user_id: number;
      entity_id: number;
      detail_json: string;
    };
    expect(row.actor_user_id).toBe(userId);
    expect(row.entity_id).toBe(doc.id);
    expect(JSON.parse(row.detail_json)).toMatchObject({ version: 1, sha256: doc.sha256 });
  });

  it("download headers: attachment, stored mime, nosniff", async () => {
    const { dealId } = await setup();
    const doc = (await (await upload({ deal_id: dealId, kind: "cim" }, { name: "Project Falcon CIM.pdf", body: "%PDF" })).json()).document;
    const res = await download(doc.id);
    expect(res.headers.get("content-type")).toBe(PDF);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Project Falcon CIM.pdf"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe("4");
  });

  it("a row whose file is missing on disk answers a clear 404 and is not audited as a download", async () => {
    const { dealId, userId } = await setup();
    const id = app.insert("documents", {
      deal_id: dealId,
      kind: "cim",
      title: "Demo CIM",
      doc_key: `deal:${dealId}:cim`,
      version: 1,
      filename: "demo.pdf",
      mime: PDF,
      size: 1234,
      sha256: "a".repeat(64),
      uploaded_by: userId,
    });
    const res = await download(id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File not available in this workspace" });
    expect(auditCount("document.download")).toBe(0);
  });
});

describe("archive and edits", () => {
  it("archive hides the group from the default list, is audited, and deletes nothing", async () => {
    const { dealId } = await setup();
    const doc = (await (await upload({ deal_id: dealId, kind: "teaser" }, { name: "t.pdf", body: "t1" })).json()).document;
    await upload({ deal_id: dealId, doc_key: doc.doc_key }, { name: "t2.pdf", body: "t2" });
    const before = { rows: docCount(), files: filesOnDisk().length };

    const res = await one.PATCH(jsonReq(`/api/documents/${doc.id}`, "PATCH", { archived: true }), params(doc.id));
    expect(res.status).toBe(200);
    expect(auditCount("document.archive")).toBe(1);
    expect((await (await list.GET(jsonReq(`/api/documents?deal_id=${dealId}`, "GET"))).json()).items).toHaveLength(0);
    const shown = (await (await list.GET(jsonReq(`/api/documents?deal_id=${dealId}&include_archived=1`, "GET"))).json()).items;
    expect(shown).toHaveLength(1);
    expect(shown[0].archived_at).toBeTruthy();
    expect((app.db.prepare("SELECT COUNT(*) n FROM documents WHERE archived_at IS NULL").get() as { n: number }).n).toBe(0);
    expect({ rows: docCount(), files: filesOnDisk().length }).toEqual(before);

    // Archived versions still download.
    expect((await download(doc.id)).status).toBe(200);

    await one.PATCH(jsonReq(`/api/documents/${doc.id}`, "PATCH", { archived: false }), params(doc.id));
    expect(auditCount("document.unarchive")).toBe(1);
    expect((await (await list.GET(jsonReq(`/api/documents?deal_id=${dealId}`, "GET"))).json()).items).toHaveLength(1);
  });

  it("title and note edits are audited with old and new values", async () => {
    const { dealId } = await setup();
    const doc = (await (await upload({ deal_id: dealId, kind: "loi" }, { name: "loi.pdf", body: "l" })).json()).document;
    const res = await one.PATCH(jsonReq(`/api/documents/${doc.id}`, "PATCH", { title: "LOI from Buyer A", note: "marked up" }), params(doc.id));
    expect((await res.json()).document).toMatchObject({ title: "LOI from Buyer A", note: "marked up" });
    const row = app.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'document.update'").get() as { detail_json: string };
    expect(JSON.parse(row.detail_json).changes.title).toEqual({ from: "loi", to: "LOI from Buyer A" });
    expect((await one.PATCH(jsonReq(`/api/documents/${doc.id}`, "PATCH", { title: "" }), params(doc.id))).status).toBe(400);
    expect((await one.PATCH(jsonReq(`/api/documents/${doc.id}`, "PATCH", { archived: "yes" }), params(doc.id))).status).toBe(400);
  });

  it("no route can delete: no DELETE handler, and every route leaves rows and files in place", async () => {
    expect("DELETE" in list).toBe(false);
    expect("DELETE" in one).toBe(false);
    expect("DELETE" in dl).toBe(false);
    const { dealId } = await setup();
    const doc = (await (await upload({ deal_id: dealId, kind: "cim" }, { name: "c.pdf", body: "c" })).json()).document;
    const file = filesOnDisk()[0];
    const size = statSync(file).size;
    await one.PATCH(jsonReq(`/api/documents/${doc.id}`, "PATCH", { archived: true, title: "renamed" }), params(doc.id));
    await download(doc.id);
    await upload({ deal_id: dealId, doc_key: doc.doc_key }, { name: "c2.pdf", body: "c2" });
    expect(docCount()).toBe(2);
    expect(statSync(file).size).toBe(size);
    expect(filesOnDisk()).toHaveLength(2);
    // A new version brings the archived group back.
    expect((await (await list.GET(jsonReq(`/api/documents?deal_id=${dealId}`, "GET"))).json()).items).toHaveLength(1);
  });
});

describe("4.3 NDA per buyer", () => {
  it("latestNdaByBuyer maps each buyer to its newest NDA version on this deal", async () => {
    const { dealId } = await setup();
    const a = app.insert("deal_buyers", { deal_id: dealId, buyer_company_id: app.company("A") });
    const b = app.insert("deal_buyers", { deal_id: dealId, buyer_company_id: app.company("B") });
    app.insert("deal_buyers", { deal_id: dealId, buyer_company_id: app.company("C") });
    await upload({ deal_id: dealId, kind: "nda", deal_buyer_id: a }, { name: "a1.pdf", body: "a1" });
    const a2 = (await (await upload({ deal_id: dealId, doc_key: `buyer:${a}:nda` }, { name: "a2.pdf", body: "a2" })).json()).document;
    const b1 = (await (await upload({ deal_id: dealId, kind: "nda", deal_buyer_id: b }, { name: "b1.pdf", body: "b1" })).json()).document;
    await upload({ deal_id: dealId, kind: "loi", deal_buyer_id: b }, { name: "loi.pdf", body: "loi" });
    expect(docs.latestNdaByBuyer(dealId)).toEqual({ [a]: a2.id, [b]: b1.id });
  });
});

describe("auth", () => {
  it("401 on every route when signed out", async () => {
    const { dealId } = await setup();
    const doc = (await (await upload({ deal_id: dealId, kind: "cim" }, { name: "c.pdf", body: "c" })).json()).document;
    harness.token = undefined;
    expect((await list.GET(jsonReq(`/api/documents?deal_id=${dealId}`, "GET"))).status).toBe(401);
    expect((await upload({ deal_id: dealId, kind: "cim" }, { name: "c.pdf", body: "c" })).status).toBe(401);
    expect((await one.GET(jsonReq(`/api/documents/${doc.id}`, "GET"), params(doc.id))).status).toBe(401);
    expect((await one.PATCH(jsonReq(`/api/documents/${doc.id}`, "PATCH", { archived: true }), params(doc.id))).status).toBe(401);
    expect((await download(doc.id)).status).toBe(401);
    expect(auditCount("document.download")).toBe(0);
  });
});

describe("deal delete with records", () => {
  it("refuses with 409, not a 500, when the deal has buyers or documents", async () => {
    const route = await import("../app/api/deals/[id]/route");
    const app = await freshApp();
    await app.signIn("owner");
    const dealId = app.deal(app.company());
    app.insert("deal_buyers", { deal_id: dealId, buyer_company_id: app.company() });
    const res = await route.DELETE(jsonReq(`/api/deals/${dealId}`, "DELETE"), params(dealId));
    expect(res.status).toBe(409);
    expect(app.db.prepare("SELECT COUNT(*) n FROM deals WHERE id = ?").get(dealId)).toEqual({ n: 1 });
  });
});
