"use client";
// Upload a CSV, map columns to contact fields, preview first 10 rows, then import.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseCsvWithHeader } from "../../lib/csv";
import { Button } from "../ui/Button";

const TARGET_FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "title", label: "Title" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "linkedin_url", label: "LinkedIn URL" },
  { key: "company_name", label: "Company name" },
  { key: "company_domain", label: "Company domain" },
];

function guessMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const lower = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const table: Record<string, string[]> = {
    first_name: ["firstname", "first"],
    last_name: ["lastname", "last"],
    title: ["title", "jobtitle", "position"],
    email: ["email", "emailaddress", "workemail"],
    phone: ["phone", "phonenumber", "mobile", "workphone"],
    linkedin_url: ["linkedin", "linkedinurl", "linkedinprofile"],
    company_name: ["company", "companyname", "organization", "org"],
    company_domain: ["domain", "companydomain", "website"],
  };
  for (const [field, aliases] of Object.entries(table)) {
    const match = headers.find((h) => aliases.includes(lower(h)));
    if (match) mapping[field] = match;
  }
  return mapping;
}

export default function CsvImport({ onDone, trigger = "Import CSV" }: { onDone?: () => void; trigger?: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; skipped_duplicate: number; skipped_invalid: number } | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { headers, rows } = parseCsvWithHeader(text);
    if (headers.length === 0) {
      setError("That file has no rows");
      return;
    }
    setHeaders(headers);
    setRows(rows);
    setMapping(guessMapping(headers));
    setResult(null);
    setError(null);
  }

  async function runImport() {
    if (!mapping.first_name && !mapping.last_name) {
      setError("Map at least a first or last name column before importing");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, mapping }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Import failed");
      setResult(data);
      router.refresh();
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setHeaders([]);
    setRows([]);
    setMapping({});
    setResult(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  // Escape closes the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {trigger}
      </Button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--ink)]/40 p-4 pt-16"
      onClick={() => {
        setOpen(false);
        reset();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="csv-import-title"
        className="card w-full max-w-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
      <div className="mb-3 flex items-center justify-between">
        <h3 id="csv-import-title" className="text-[16px] font-bold text-[var(--ink)]">Import contacts from a list</h3>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            setOpen(false);
            reset();
          }}
        >
          Close
        </Button>
      </div>

      {error && <p className="mb-3 text-sm text-[var(--bad)]">{error}</p>}

      {result ? (
        <div className="space-y-2">
          <p className="text-sm text-[var(--ink)]">Import complete.</p>
          <ul className="text-sm text-[var(--ink-soft)]">
            <li>Created: {result.created}</li>
            <li>Updated: {result.updated}</li>
            <li>Skipped (duplicate): {result.skipped_duplicate}</li>
            <li>Skipped (invalid): {result.skipped_invalid}</li>
          </ul>
          <Button variant="secondary" size="sm" onClick={reset} className="mt-2">
            Import another file
          </Button>
        </div>
      ) : headers.length === 0 ? (
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="text-sm" />
      ) : (
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs text-[var(--ink-faint)]">
              {rows.length} rows found. Map each CRM field to a column from your file (leave unmapped fields blank).
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {TARGET_FIELDS.map((f) => (
                <label key={f.key} className="flex items-center gap-2 text-sm">
                  <span className="w-32 shrink-0 text-[var(--ink-soft)]">{f.label}</span>
                  <select
                    className="min-h-[44px] flex-1 rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm"
                    value={mapping[f.key] ?? ""}
                    onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                  >
                    <option value="">Not mapped</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1 text-[12px] font-semibold text-[var(--ink-soft)]">Preview (first 10 rows)</p>
            <div className="overflow-x-auto rounded-[12px] bg-[var(--paper)]">
              <table className="w-full min-w-[600px] border-collapse text-xs">
                <thead>
                  <tr>
                    {headers.map((h) => (
                      <th key={h} className="px-2 py-1 text-left font-medium text-[var(--ink-faint)]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 10).map((r, i) => (
                    <tr key={i} className="border-t border-[var(--rule)]">
                      {headers.map((h) => (
                        <td key={h} className="px-2 py-1 text-[var(--ink)]">
                          {r[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={runImport} disabled={busy}>
              {busy ? "Importing..." : `Import ${rows.length} rows`}
            </Button>
            <Button variant="secondary" onClick={reset}>
              Choose a different file
            </Button>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
