"use client";
// 4Degrees Deal List import: upload or paste the CSV, confirm the column
// mapping, look at what each row will do (a server dry run, nothing saved),
// then import. The per-row preview is the real import rolled back.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseCsvWithHeader } from "../../lib/csv";
import { IMPORT_FIELDS, detectMapping, type ImportMapping } from "../../lib/import4dMap";
import { BUYER_STAGE_LABELS, isBuyerStage } from "../../lib/buyerStages";
import type { ImportResult, RowResult } from "../../lib/import4d";
import Panel from "../ui/Panel";
import { Button, ButtonLink } from "../ui/Button";
import StatusLabel from "../ui/StatusLabel";

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";

function stageCell(r: RowResult) {
  if (!r.stage) return "";
  if (r.stage === "declined") {
    const from = isBuyerStage(r.declined_from_stage) ? BUYER_STAGE_LABELS[r.declined_from_stage] : "";
    return (
      <span>
        <span className="font-semibold text-[var(--ink)]">Declined{from ? ` after ${from}` : ""}</span>
        {r.decline_reason && <span className="block text-[12px] text-[var(--ink-soft)]">{r.decline_reason}</span>}
      </span>
    );
  }
  return <span className="font-semibold text-[var(--ink)]">{BUYER_STAGE_LABELS[r.stage]}</span>;
}

const ACTION: Record<RowResult["action"], { kind: "ok" | "info" | "none"; preview: string; done: string }> = {
  created: { kind: "ok", preview: "Will add", done: "Added" },
  updated: { kind: "info", preview: "Will restore", done: "Restored" },
  skipped: { kind: "none", preview: "Skip", done: "Skipped" },
};

function RowsTable({ rows, done }: { rows: RowResult[]; done: boolean }) {
  const shown = rows.filter((r) => !(r.action === "skipped" && r.messages.length === 1 && r.messages[0] === "Blank row"));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[12px] font-semibold text-[var(--ink-soft)]">
            <th className="px-2 py-2">Row</th>
            <th className="px-2 py-2">Buyer</th>
            <th className="px-2 py-2">Contact</th>
            <th className="px-2 py-2">Stage on the log</th>
            <th className="px-2 py-2">Dated</th>
            <th className="px-2 py-2">Result</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.row} className="border-t border-[var(--rule)] align-top">
              <td className="px-2 py-2 text-[var(--ink-faint)]">{r.row}</td>
              <td className="px-2 py-2 font-semibold text-[var(--ink)]">{r.company || <span className="text-[var(--ink-faint)]">No name</span>}</td>
              <td className="px-2 py-2 text-[var(--ink-soft)]">{r.contact}</td>
              <td className="px-2 py-2">{r.action === "skipped" ? <span className="text-[var(--ink-faint)]">Unchanged</span> : stageCell(r)}</td>
              <td className="whitespace-nowrap px-2 py-2 text-[var(--ink-soft)]">{fmtDate(r.date)}</td>
              <td className="px-2 py-2">
                <StatusLabel kind={ACTION[r.action].kind}>{done ? ACTION[r.action].done : ACTION[r.action].preview}</StatusLabel>
                {r.messages.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[12px] text-[var(--ink-soft)]">
                    {r.messages.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Summary({ r, done }: { r: ImportResult; done: boolean }) {
  const parts = [
    `${r.created} ${done ? "added" : "to add"}`,
    r.updated ? `${r.updated} ${done ? "restored" : "to restore"}` : "",
    `${r.skipped} skipped`,
  ].filter(Boolean);
  const extras = [
    r.companies_created ? `${r.companies_created} new ${r.companies_created === 1 ? "company" : "companies"}` : "",
    r.contacts_created ? `${r.contacts_created} new ${r.contacts_created === 1 ? "contact" : "contacts"}` : "",
    r.notes_added ? `${r.notes_added} ${r.notes_added === 1 ? "note" : "notes"} on the deal timeline` : "",
  ].filter(Boolean);
  return (
    <p className="text-sm text-[var(--ink)]">
      <span className="font-semibold">{parts.join(", ")}.</span>
      {extras.length > 0 && <span className="text-[var(--ink-soft)]"> {extras.join(", ")}.</span>}
    </p>
  );
}

export default function Import4D({ dealId }: { dealId: number }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState("");
  const [paste, setPaste] = useState("");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load(raw: string, name: string) {
    const text = raw.replace(/^\uFEFF/, "");
    const { headers } = parseCsvWithHeader(text);
    if (!headers.length) {
      setError("That file has no header row");
      return;
    }
    setCsv(text);
    setFileName(name);
    setHeaders(headers);
    setMapping(detectMapping(headers));
    setPreview(null);
    setResult(null);
    setError(null);
  }

  const post = useCallback(
    async (dryRun: boolean) => {
      const res = await fetch(`/api/deals/${dealId}/import-buyers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv, mapping, dry_run: dryRun }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Import failed");
      return data as ImportResult;
    },
    [csv, mapping, dealId]
  );

  // Re-run the dry run whenever the file or the mapping changes.
  useEffect(() => {
    if (!csv || result || !mapping.company) return;
    let live = true;
    const t = setTimeout(() => {
      post(true)
        .then((r) => {
          if (!live) return;
          setPreview(r);
          setError(null);
        })
        .catch((e) => live && setError(e instanceof Error ? e.message : "Preview failed"));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [csv, mapping, post, result]);

  async function runImport() {
    setBusy(true);
    setError(null);
    try {
      const r = await post(false);
      setResult(r);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setCsv("");
    setPaste("");
    setFileName("");
    setHeaders([]);
    setMapping({});
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  if (result) {
    return (
      <Panel title="Import finished">
        <Summary r={result} done />
        <div className="mt-3 flex flex-wrap gap-2">
          <ButtonLink href={`/pipeline/${dealId}`} size="sm">
            Back to the buyer log
          </ButtonLink>
          <Button variant="secondary" size="sm" onClick={reset}>
            Import another file
          </Button>
        </div>
        <div className="mt-4">
          <RowsTable rows={result.rows} done />
        </div>
      </Panel>
    );
  }

  if (!csv) {
    return (
      <Panel title="Choose the export">
        {error && <p className="mb-3 text-sm text-[var(--bad)]">{error}</p>}
        <label className="block text-sm font-semibold text-[var(--ink)]" htmlFor="import-file">
          Upload the CSV
        </label>
        <input
          id="import-file"
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="mt-1 min-h-[44px] text-sm"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) load(await f.text(), f.name);
          }}
        />
        <p className="my-4 text-[12px] font-semibold uppercase tracking-wide text-[var(--ink-faint)]">or paste it</p>
        <textarea
          aria-label="Paste CSV"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={6}
          placeholder="Company/Contact,Primary Contact,Stage,Outcome,Notes,Last Interaction,Location"
          className="w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] p-3 font-mono text-[13px] text-[var(--ink)] outline-none focus-visible:border-[var(--accent)]"
        />
        <div className="mt-2">
          <Button variant="secondary" size="sm" disabled={!paste.trim()} onClick={() => load(paste, "Pasted text")}>
            Use pasted text
          </Button>
        </div>
      </Panel>
    );
  }

  const needCompany = !mapping.company;
  const shownPreview = needCompany ? null : preview;
  const importable = shownPreview ? shownPreview.created + shownPreview.updated : 0;
  return (
    <div className="space-y-5">
      <Panel
        title={<span>Columns <span className="text-[13px] font-medium text-[var(--ink-soft)]">{fileName}</span></span>}
        actions={
          <Button variant="quiet" size="sm" onClick={reset}>
            Choose a different file
          </Button>
        }
      >
        <p className="mb-3 text-[13px] text-[var(--ink-soft)]">We matched these from the file&apos;s headers. Change any that are wrong; the preview updates.</p>
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {IMPORT_FIELDS.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <span className="w-32 shrink-0 text-[var(--ink-soft)]">
                {f.label}
                {"required" in f && f.required ? " *" : ""}
              </span>
              <select
                className="min-h-[44px] min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]"
                value={mapping[f.key] ?? ""}
                onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
              >
                <option value="">Not in this file</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </Panel>

      <Panel
        title="Preview"
        actions={
          <Button variant="accent" size="sm" disabled={busy || !shownPreview || importable === 0} onClick={runImport}>
            {busy ? "Importing..." : `Import ${importable} ${importable === 1 ? "buyer" : "buyers"}`}
          </Button>
        }
      >
        {needCompany && <p className="mb-3 text-sm text-[var(--bad)]">Pick the column that holds the company name.</p>}
        {error && !needCompany && <p className="mb-3 text-sm text-[var(--bad)]">{error}</p>}
        {shownPreview ? (
          <>
            <Summary r={shownPreview} done={false} />
            <p className="mt-1 text-[12px] text-[var(--ink-faint)]">Nothing has been saved yet. Milestones and notes take the Last Interaction date; a date in the future is replaced with today.</p>
            <div className="mt-4">
              <RowsTable rows={shownPreview.rows} done={false} />
            </div>
          </>
        ) : (
          !error && !needCompany && <p className="text-sm text-[var(--ink-soft)]">Reading the file...</p>
        )}
      </Panel>
    </div>
  );
}
