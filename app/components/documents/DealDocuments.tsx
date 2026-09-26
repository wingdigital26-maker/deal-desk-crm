"use client";
// Deal documents: engagement letter, NDAs, teaser, CIM, LOIs, financials.
// Every upload is a new version (older versions stay downloadable), nothing is
// ever deleted, and "Archive" only hides a document from the default list.
// Downloads go through /api/documents/[id]/download, which audits each one.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";
import EmptyState from "../crm/EmptyState";
import { FieldInput, inputClass } from "../crm/Field";
import {
  ACCEPT_ATTR,
  BUYER_KINDS,
  DOC_KINDS,
  DOC_KIND_GROUPS,
  DOC_KIND_LABELS,
  MAX_UPLOAD_BYTES,
  formatBytes,
  type DocKind,
} from "../../lib/documentKinds";
import type { DocumentGroup, DocumentVersion } from "../../lib/documents";

type BuyerOption = { id: number; buyer_name: string };

const selectClass =
  "h-[44px] w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-[16px] text-[var(--ink)]";

const when = (s: string) =>
  new Date(s.replace(" ", "T") + (s.includes("T") ? "" : "Z")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const typeLabel = (filename: string) => {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toUpperCase() : "";
};

export default function DealDocuments({ dealId, initial }: { dealId: number; initial: DocumentGroup[] }) {
  const router = useRouter();
  const [items, setItems] = useState<DocumentGroup[]>(initial);
  const [showArchived, setShowArchived] = useState(false);
  const [uploading, setUploading] = useState<{ docKey?: string; title?: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(
    async (archived = showArchived) => {
      const res = await fetch(`/api/documents?deal_id=${dealId}${archived ? "&include_archived=1" : ""}`).catch(() => null);
      if (res?.ok) setItems((await res.json()).items);
      // The buyer log's "NDA on file" comes from the server page; refresh it too.
      router.refresh();
    },
    [dealId, showArchived, router]
  );

  async function download(v: Pick<DocumentVersion, "id" | "filename">) {
    setError(null);
    const res = await fetch(`/api/documents/${v.id}/download`).catch(() => null);
    if (!res || !res.ok) {
      const d = await res?.json().catch(() => ({}));
      setError(d?.error ?? "That file could not be downloaded.");
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = v.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function setArchived(doc: DocumentGroup, archived: boolean) {
    setError(null);
    const res = await fetch(`/api/documents/${doc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    }).catch(() => null);
    if (!res?.ok) {
      setError("That change was not saved.");
      return;
    }
    setNotice(archived ? `"${doc.title}" archived. It is kept on file; use Show archived to see it.` : `"${doc.title}" restored.`);
    await reload();
  }

  const toggleOpen = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groups = DOC_KINDS.map((k) => ({ kind: k, docs: items.filter((d) => d.kind === k) })).filter((g) => g.docs.length);
  const live = items.filter((d) => !d.archived_at).length;

  return (
    <Panel
      title={
        <span>
          Documents <span className="text-[13px] font-medium text-[var(--ink-soft)]">{live} {live === 1 ? "document" : "documents"}</span>
        </span>
      }
      actions={
        <>
          <Button
            size="sm"
            variant="quiet"
            aria-pressed={showArchived}
            onClick={async () => {
              const next = !showArchived;
              setShowArchived(next);
              await reload(next);
            }}
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Button size="sm" onClick={() => setUploading((u) => (u && !u.docKey ? null : {}))}>
            {uploading && !uploading.docKey ? "Close" : "Upload"}
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-[var(--ink-soft)]">Every upload is kept as a version. Nothing here is ever deleted, and each download is logged.</p>

      {uploading && !uploading.docKey && (
        <div className="mt-4">
          <UploadForm
            dealId={dealId}
            onCancel={() => setUploading(null)}
            onDone={async (msg) => {
              setUploading(null);
              setNotice(msg);
              await reload();
            }}
          />
        </div>
      )}

      {notice && <div className="mt-3 text-sm text-[var(--ink-soft)]">{notice}</div>}
      {error && (
        <div role="alert" className="mt-3 text-sm text-[var(--bad)]">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title={showArchived ? "No documents on this deal" : "No documents on this deal yet"}
            detail="Upload the engagement letter, the teaser and CIM, buyer NDAs and LOIs. Each new upload of the same document becomes a new version."
            action={!uploading ? <Button variant="secondary" onClick={() => setUploading({})}>Upload a document</Button> : undefined}
          />
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          {groups.map((g) => (
            <section key={g.kind} aria-labelledby={`docs-${g.kind}`}>
              <h3 id={`docs-${g.kind}`} className="label mb-2">
                {DOC_KIND_GROUPS[g.kind]} <span className="text-[var(--ink-faint)]">{g.docs.length}</span>
              </h3>
              <ul className="space-y-2">
                {g.docs.map((d) => {
                  const expanded = open.has(d.doc_key);
                  return (
                    <li key={d.doc_key} className="rounded-[14px] bg-[var(--paper)] p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-semibold text-[var(--ink)]">{d.title}</span>
                            <span className="numeric rounded-full bg-[var(--surface)] px-2 text-[12px] text-[var(--ink)]">v{d.version}</span>
                            {d.archived_at && <span className="text-[12px] font-semibold text-[var(--ink-soft)]">Archived</span>}
                          </div>
                          <div className="mt-0.5 text-[12px] text-[var(--ink-soft)]">
                            {[
                              d.buyer_name && !d.title.includes(d.buyer_name) ? d.buyer_name : null,
                              typeLabel(d.filename),
                              formatBytes(d.size),
                              `${d.uploaded_by_name ? `${d.uploaded_by_name}, ` : ""}${when(d.created_at)}`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                          {d.note && <div className="mt-1 text-[12px] text-[var(--ink-soft)]">{d.note}</div>}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button size="sm" variant="secondary" onClick={() => download(d)} aria-label={`Download ${d.title} v${d.version}`}>
                            Download
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setUploading({ docKey: d.doc_key, title: d.title })}>
                            Upload new version
                          </Button>
                          <Button size="sm" variant="quiet" aria-expanded={expanded} onClick={() => toggleOpen(d.doc_key)}>
                            {d.version_count === 1 ? "History" : `History (${d.version_count})`}
                          </Button>
                          <Button size="sm" variant="quiet" onClick={() => setArchived(d, !d.archived_at)}>
                            {d.archived_at ? "Restore" : "Archive"}
                          </Button>
                        </div>
                      </div>

                      {uploading?.docKey === d.doc_key && (
                        <div className="mt-3">
                          <UploadForm
                            dealId={dealId}
                            docKey={d.doc_key}
                            currentTitle={d.title}
                            onCancel={() => setUploading(null)}
                            onDone={async (msg) => {
                              setUploading(null);
                              setNotice(msg);
                              await reload();
                            }}
                          />
                        </div>
                      )}

                      {expanded && (
                        <ol className="mt-3 divide-y divide-[var(--rule)] rounded-[12px] bg-[var(--surface)] px-3" aria-label={`Versions of ${d.title}`}>
                          {d.versions.map((ver) => (
                            <li key={ver.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                              <div className="min-w-0 text-[13px]">
                                <span className="numeric font-semibold text-[var(--ink)]">v{ver.version}</span>{" "}
                                <span className="break-all text-[var(--ink)]">{ver.filename}</span>
                                <div className="text-[12px] text-[var(--ink-soft)]">
                                  {formatBytes(ver.size)} · {ver.uploaded_by_name ? `${ver.uploaded_by_name}, ` : ""}
                                  {when(ver.created_at)}
                                  {ver.note ? ` · ${ver.note}` : ""}
                                </div>
                              </div>
                              <Button size="sm" variant="quiet" onClick={() => download(ver)} aria-label={`Download ${d.title} v${ver.version}`}>
                                Download v{ver.version}
                              </Button>
                            </li>
                          ))}
                        </ol>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

function UploadForm({
  dealId,
  docKey,
  currentTitle,
  onCancel,
  onDone,
}: {
  dealId: number;
  docKey?: string;
  currentTitle?: string;
  onCancel: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const isVersion = Boolean(docKey);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<DocKind>("cim");
  const [title, setTitle] = useState("");
  const [buyerId, setBuyerId] = useState("");
  const [note, setNote] = useState("");
  const [buyers, setBuyers] = useState<BuyerOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idp = `up-${docKey ?? "new"}`;
  const forBuyer = (BUYER_KINDS as DocKind[]).includes(kind);

  // The buyer list only matters for NDAs and LOIs; fetch it the first time it is needed.
  const needBuyers = !isVersion && forBuyer && buyers === null;
  useEffect(() => {
    if (!needBuyers) return;
    const ctrl = new AbortController();
    fetch(`/api/deal-buyers?deal_id=${dealId}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => setBuyers(Array.isArray(d.items) ? d.items.map((b: BuyerOption) => ({ id: b.id, buyer_name: b.buyer_name })) : []))
      .catch(() => {});
    return () => ctrl.abort();
  }, [needBuyers, dealId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) return setError("Choose a file first.");
    if (file.size > MAX_UPLOAD_BYTES) return setError("Files must be 25 MB or smaller.");
    const form = new FormData();
    form.set("file", file);
    form.set("deal_id", String(dealId));
    if (docKey) form.set("doc_key", docKey);
    else form.set("kind", kind);
    if (title.trim()) form.set("title", title.trim());
    if (!isVersion && forBuyer && buyerId) form.set("deal_buyer_id", buyerId);
    if (note.trim()) form.set("note", note.trim());
    setBusy(true);
    const res = await fetch("/api/documents", { method: "POST", body: form }).catch(() => null);
    setBusy(false);
    if (!res) return setError("Could not reach the server.");
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setError(d?.error ?? "The upload did not save.");
    await onDone(`Saved "${d.document.title}" as v${d.document.version}.`);
  }

  return (
    <form onSubmit={submit} className="rounded-[14px] border border-[var(--rule)] bg-[var(--surface)] p-4">
      <p className="mb-3 text-sm font-semibold text-[var(--ink)]">{isVersion ? `New version of "${currentTitle}"` : "Upload a document"}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldInput label="File" htmlFor={`${idp}-file`} hint="PDF, Word, Excel, PowerPoint, CSV, text, images, email or zip. Up to 25 MB.">
          <input
            id={`${idp}-file`}
            type="file"
            accept={ACCEPT_ATTR}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block min-h-[44px] w-full text-sm text-[var(--ink)] file:mr-3 file:min-h-[40px] file:rounded-[var(--radius-sm)] file:border file:border-[var(--rule-strong)] file:bg-[var(--surface)] file:px-3 file:text-sm file:font-semibold file:text-[var(--ink)]"
          />
        </FieldInput>
        {!isVersion && (
          <FieldInput label="Kind" htmlFor={`${idp}-kind`}>
            <select id={`${idp}-kind`} value={kind} onChange={(e) => setKind(e.target.value as DocKind)} className={selectClass}>
              {DOC_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DOC_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </FieldInput>
        )}
        <FieldInput label="Title" htmlFor={`${idp}-title`} hint={isVersion ? "Leave blank to keep the current title." : "Leave blank to use the file name."}>
          <input id={`${idp}-title`} value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} placeholder={currentTitle ?? ""} maxLength={200} />
        </FieldInput>
        {!isVersion && forBuyer && (
          <FieldInput
            label="Buyer"
            htmlFor={`${idp}-buyer`}
            hint={buyers && buyers.length === 0 ? "No buyers on this deal's buyer log yet." : "The buyer this document is with."}
          >
            <select id={`${idp}-buyer`} value={buyerId} onChange={(e) => setBuyerId(e.target.value)} className={selectClass}>
              <option value="">Not tied to a buyer</option>
              {(buyers ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.buyer_name}
                </option>
              ))}
            </select>
          </FieldInput>
        )}
        <div className="sm:col-span-2">
          <FieldInput label="Note" htmlFor={`${idp}-note`} hint="Optional. For example: seller comments incorporated.">
            <input id={`${idp}-note`} value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} maxLength={5000} />
          </FieldInput>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--bad)]">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !file}>
          {busy ? "Uploading..." : isVersion ? "Save new version" : "Upload"}
        </Button>
      </div>
    </form>
  );
}
