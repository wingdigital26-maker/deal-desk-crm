"use client";
// Search-as-you-type against /api/companies?q=, owned by another agent this
// round. Coded defensively: any non-2xx, non-JSON, or unexpected shape is
// treated as "no results" rather than thrown.
import { useEffect, useId, useRef, useState } from "react";
import type { CompanyOption } from "./types";

export default function CompanySearch({
  onSelect,
  placeholder = "Search companies by name or domain",
}: {
  onSelect: (company: CompanyOption) => void;
  placeholder?: string;
}) {
  // Unique per instance: the board can mount this form in a desktop column
  // and the phone column at once, and duplicate ids break the label link.
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CompanyOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trimmed = query.trim();

  // Abortable + debounced: this effect only ever calls setState from inside
  // the async callback (guarded by `cancelled`/AbortController), never
  // synchronously in the effect body, so a short query is handled by the
  // caller resetting state in the onChange event (see handleChange) instead
  // of an early setState-in-effect here.
  useEffect(() => {
    if (trimmed.length < 2) return;
    const controller = new AbortController();
    let cancelled = false;
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/companies?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          setBroken(true);
          setResults([]);
          return;
        }
        const data: unknown = await res.json();
        // /api/companies answers { rows, total, ... }. Reading only `items`
        // left this box permanently on "No matching companies".
        const obj = data && typeof data === "object" ? (data as { rows?: unknown; items?: unknown }) : {};
        const items = Array.isArray(obj.rows) ? obj.rows : Array.isArray(obj.items) ? obj.items : [];
        const safe: CompanyOption[] = items
          .filter(
            (it): it is CompanyOption =>
              !!it &&
              typeof it === "object" &&
              typeof (it as CompanyOption).id === "number" &&
              typeof (it as CompanyOption).name === "string"
          )
          .map((it) => ({ id: it.id, name: it.name, domain: it.domain ?? null }));
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
      // Below the search threshold: reset synchronously from the event that
      // caused it, not from an effect.
      setResults([]);
      setBroken(false);
      setLoading(false);
    }
  }

  return (
    <div className="relative">
      <label className="mb-1 block text-sm font-medium text-[var(--ink-soft)]" htmlFor={inputId}>
        Company
      </label>
      <input
        id={inputId}
        type="text"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="min-h-[44px] w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)] focus:border-[var(--accent)]"
        autoComplete="off"
      />
      {open && query.trim().length >= 2 && (
        <div className="card absolute z-10 mt-1 max-h-72 w-full overflow-y-auto">
          {loading && <div className="px-3 py-2 text-sm text-[var(--ink-faint)]">Searching...</div>}
          {!loading && broken && (
            <div className="px-3 py-2 text-sm text-[var(--bad)]">
              Company search is unavailable right now. Try again shortly.
            </div>
          )}
          {!loading && !broken && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-[var(--ink-faint)]">No matching companies.</div>
          )}
          {!loading &&
            !broken &&
            results.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onSelect(c);
                  setQuery(c.name);
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--paper)]"
              >
                <span className="text-[var(--ink)]">{c.name}</span>
                {c.domain && <span className="ml-2 text-[var(--ink-faint)]">{c.domain}</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
