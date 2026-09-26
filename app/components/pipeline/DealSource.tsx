"use client";
// "Sourced by" on a deal: the referral source (a contact) who brought it in.
// Changing it moves the credit on Contacts > Referral sources straight away.
import { useEffect, useId, useState } from "react";
import Link from "next/link";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";
import { referralKindLabel } from "../../lib/referralKinds";

type Person = { id: number; first_name: string | null; last_name: string | null; title?: string | null; company_name?: string | null; referral_kind?: string | null };

const nameOf = (p: Person) => [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed";

export default function DealSource({ dealId, contactId }: { dealId: number; contactId: number | null }) {
  const inputId = useId();
  const [current, setCurrent] = useState<Person | null>(null);
  const [currentId, setCurrentId] = useState<number | null>(contactId);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the credited person's name once (the deal row only carries the id).
  useEffect(() => {
    if (currentId == null) return;
    let cancelled = false;
    fetch(`/api/contacts/${currentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.row) setCurrent(data.row as Person);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed.length < 2) return;
    const controller = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/contacts?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal });
        const data = res.ok ? await res.json() : null;
        setResults(Array.isArray(data?.rows) ? (data.rows as Person[]).slice(0, 8) : []);
      } catch {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
  }, [trimmed]);

  async function save(person: Person | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referral_contact_id: person ? person.id : null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not save.");
        return;
      }
      setCurrent(person);
      setCurrentId(person ? person.id : null);
      setPicking(false);
      setQuery("");
      setResults([]);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Sourced by">
      {error && <p className="mb-2 text-sm text-[var(--bad)]">{error}</p>}
      {!picking && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {currentId != null ? (
            <div className="min-w-0">
              <Link href={`/contacts/${currentId}`} className="text-sm font-medium text-[var(--ink)] hover:underline">
                {current ? nameOf(current) : "Loading..."}
              </Link>
              {current && (current.referral_kind || current.title) && (
                <div className="text-xs text-[var(--ink-soft)]">
                  {current.referral_kind ? referralKindLabel(current.referral_kind) : current.title}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-[var(--ink-faint)]">No referral source credited.</p>
          )}
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
              {currentId != null ? "Change" : "Credit someone"}
            </Button>
            {currentId != null && (
              <Button size="sm" variant="quiet" disabled={busy} onClick={() => save(null)}>
                Clear
              </Button>
            )}
          </div>
        </div>
      )}
      {picking && (
        <div className="relative">
          <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-[var(--ink-soft)]">
            Who sourced this deal?
          </label>
          <input
            id={inputId}
            type="search"
            autoFocus
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value.trim().length < 2) setResults([]);
            }}
            placeholder="Search people by name, email or firm"
            className="min-h-[44px] w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)] focus:border-[var(--accent)]"
          />
          {trimmed.length >= 2 && (
            <div className="card mt-1 max-h-72 overflow-y-auto">
              {searching && <div className="px-3 py-2 text-sm text-[var(--ink-faint)]">Searching...</div>}
              {!searching && results.length === 0 && <div className="px-3 py-2 text-sm text-[var(--ink-faint)]">No matching people.</div>}
              {!searching &&
                results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={busy}
                    onClick={() => save(p)}
                    className="block min-h-[44px] w-full px-3 py-2 text-left text-sm hover:bg-[var(--paper)]"
                  >
                    <span className="text-[var(--ink)]">{nameOf(p)}</span>
                    {p.company_name && <span className="ml-2 text-[var(--ink-faint)]">{p.company_name}</span>}
                  </button>
                ))}
            </div>
          )}
          <div className="mt-2">
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                setPicking(false);
                setQuery("");
                setResults([]);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
