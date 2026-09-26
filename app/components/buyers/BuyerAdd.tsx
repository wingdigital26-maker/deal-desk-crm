"use client";
// Bulk add for the buyer log. Two ways in: pick companies (known buyers from
// earlier processes are offered first), or paste a CSV with name/domain
// columns that is matched to existing companies. Nothing here creates a
// company; unmatched rows are listed for the banker to resolve.
import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { inputClass } from "../crm/Field";
import { parseCsvWithHeader } from "../../lib/csv";
import { BUYER_TYPE_LABELS, type BuyerType } from "../../lib/buyerStages";

type Candidate = { id: number; name: string; domain: string | null; buyer_type: string | null; times_shown: number };
type Resolved = { input: { name: string; domain: string }; match: { id: number; name: string; domain: string | null } | null; ambiguous: boolean };

export default function BuyerAdd({ dealId, onAdded }: { dealId: number; onAdded: (message: string) => void }) {
  const [tab, setTab] = useState<"pick" | "csv">("pick");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Map<number, string>>(new Map());
  const [csv, setCsv] = useState("");
  const [resolved, setResolved] = useState<Resolved[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "pick") return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/deal-buyers/candidates?deal_id=${dealId}&q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => setItems(Array.isArray(d.items) ? d.items : []))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, dealId, tab]);

  async function add(ids: number[]) {
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/deal-buyers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal_id: dealId, buyers: ids.map((id) => ({ buyer_company_id: id })) }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d?.error ?? "Could not add those buyers.");
        return;
      }
      const added = d.created.length + d.restored.length;
      onAdded(`Added ${added} ${added === 1 ? "buyer" : "buyers"}${d.skipped.length ? `, skipped ${d.skipped.length} already on the log` : ""}.`);
      setPicked(new Map());
      setResolved(null);
      setCsv("");
      setQ("");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function resolve() {
    setError(null);
    const { headers, rows } = parseCsvWithHeader(csv.trim());
    const key = (want: string[]) => headers.find((h) => want.includes(h.toLowerCase().trim()));
    const nameKey = key(["name", "company", "company name", "buyer", "firm"]);
    const domainKey = key(["domain", "website", "url", "web"]);
    // A single column with no recognised header is treated as names.
    const lines = !nameKey && !domainKey ? [headers[0], ...rows.map((r) => r[headers[0]])].filter(Boolean).map((n) => ({ name: n, domain: "" })) : rows.map((r) => ({ name: nameKey ? r[nameKey] : "", domain: domainKey ? r[domainKey] : "" }));
    if (!lines.length) {
      setError("Paste at least one row. A header row with name and domain columns works best.");
      return;
    }
    const res = await fetch("/api/deal-buyers/candidates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: lines }) }).catch(() => null);
    if (!res?.ok) {
      setError("Could not match those rows.");
      return;
    }
    setResolved((await res.json()).items);
  }

  const matched = resolved?.filter((r) => r.match) ?? [];
  const unmatched = resolved?.filter((r) => !r.match) ?? [];

  return (
    <div className="rounded-[14px] border border-[var(--rule)] p-4">
      <div className="card mb-3 inline-flex p-0.5 text-sm">
        {(["pick", "csv"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={`min-h-[40px] rounded-[var(--radius-sm)] px-3 ${tab === t ? "bg-[var(--paper-deep)] font-medium text-[var(--ink)]" : "text-[var(--ink-soft)]"}`}
          >
            {t === "pick" ? "From companies" : "Paste a CSV"}
          </button>
        ))}
      </div>
      {error && <div className="mb-2 text-sm text-[var(--bad)]">{error}</div>}

      {tab === "pick" ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies by name or domain" aria-label="Search companies to add as buyers" className={inputClass} />
          <p className="mt-2 text-[12px] text-[var(--ink-faint)]">
            {q.trim() ? "Companies that match. Known buyers first." : "Buyers you have profiled or shown earlier deals, most-shown first."}
          </p>
          <ul className="mt-2 max-h-[320px] divide-y divide-[var(--rule)] overflow-y-auto">
            {items === null ? (
              <li className="py-3 text-sm text-[var(--ink-faint)]">Loading...</li>
            ) : items.length === 0 ? (
              <li className="py-3 text-sm text-[var(--ink-soft)]">{q.trim() ? "No companies match." : "No known buyers yet. Search for a company to add the first."}</li>
            ) : (
              items.map((c) => (
                <li key={c.id}>
                  <label className="flex min-h-[48px] cursor-pointer items-center gap-3 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.has(c.id)}
                      onChange={() =>
                        setPicked((cur) => {
                          const next = new Map(cur);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.set(c.id, c.name);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-[var(--ink)]">{c.name}</span>
                      <span className="block truncate text-[12px] text-[var(--ink-soft)]">
                        {[c.buyer_type ? BUYER_TYPE_LABELS[c.buyer_type as BuyerType] : null, c.domain, c.times_shown ? `shown ${c.times_shown} ${c.times_shown === 1 ? "deal" : "deals"}` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </label>
                </li>
              ))
            )}
          </ul>
          <div className="mt-3 flex justify-end">
            <Button disabled={!picked.size || busy} onClick={() => add([...picked.keys()])}>
              {busy ? "Adding..." : `Add ${picked.size || ""} ${picked.size === 1 ? "buyer" : "buyers"}`.replace("  ", " ")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <label htmlFor="buyer-csv" className="mb-1 block text-sm font-medium text-[var(--ink)]">
            Paste rows with a header, for example <span className="font-mono text-[12px]">name,domain</span>
          </label>
          <textarea id="buyer-csv" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} className={`${inputClass} h-auto py-2 font-mono text-[13px]`} />
          <div className="mt-2 flex justify-end">
            <Button variant="secondary" disabled={!csv.trim()} onClick={resolve}>
              Match to companies
            </Button>
          </div>
          {resolved && (
            <div className="mt-3 text-sm">
              <p className="text-[var(--ink)]">
                {matched.length} matched, {unmatched.length} not found.
              </p>
              {unmatched.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-[12px] text-[var(--ink-soft)]">
                  {unmatched.slice(0, 20).map((r, i) => (
                    <li key={i}>
                      {r.input.name || r.input.domain}
                      {r.ambiguous ? ": more than one company has this name, add it from the company list" : ": not in your companies yet, add the company first"}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex justify-end">
                <Button disabled={!matched.length || busy} onClick={() => add([...new Set(matched.map((r) => r.match!.id))])}>
                  Add {matched.length} matched
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
