"use client";
// Search-as-you-type against /api/deals?q=, used to attach a task to a deal
// from /tasks (deal detail's own task form already knows its deal).
import { useEffect, useRef, useState } from "react";
import type { DealOption } from "./types";

export default function DealSearch({
  onSelect,
  placeholder = "Search deals by title or company",
  id,
}: {
  id?: string;
  onSelect: (deal: DealOption) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DealOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trimmed = query.trim();

  // Same shape as CompanySearch: only ever setState from the async callback,
  // never synchronously in the effect body.
  useEffect(() => {
    if (trimmed.length < 2) return;
    const controller = new AbortController();
    let cancelled = false;
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/deals?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          setBroken(true);
          setResults([]);
          return;
        }
        const data: unknown = await res.json();
        const items =
          data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)
            ? (data as { items: unknown[] }).items
            : [];
        const safe: DealOption[] = items
          .filter(
            (it): it is DealOption =>
              !!it &&
              typeof it === "object" &&
              typeof (it as DealOption).id === "number" &&
              typeof (it as DealOption).title === "string"
          )
          .map((it) => ({ id: it.id, title: it.title, company_name: it.company_name ?? null }));
        setBroken(false);
        setResults(safe);
      } catch {
        if (!cancelled) {
          setBroken(true);
          setResults([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [trimmed]);

  function handleChange(value: string) {
    setQuery(value);
    setOpen(true);
    if (value.trim().length < 2) {
      setResults([]);
      setBroken(false);
      setLoading(false);
    }
  }

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="min-h-[44px] w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)] outline-none focus-visible:border-[var(--accent)]"
        autoComplete="off"
      />
      {open && trimmed.length >= 2 && (
        <div className="card absolute z-10 mt-1 max-h-72 w-full overflow-y-auto">
          {loading && <div className="px-3 py-2 text-sm text-[var(--ink-faint)]">Searching...</div>}
          {!loading && broken && (
            <div className="px-3 py-2 text-sm text-[var(--bad)]">Deal search is unavailable right now. Try again shortly.</div>
          )}
          {!loading && !broken && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-[var(--ink-faint)]">No matching deals.</div>
          )}
          {!loading &&
            !broken &&
            results.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => {
                  onSelect(d);
                  setQuery(d.title);
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--paper)]"
              >
                <span className="text-[var(--ink)]">{d.title}</span>
                {d.company_name && <span className="ml-2 text-[var(--ink-faint)]">{d.company_name}</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
