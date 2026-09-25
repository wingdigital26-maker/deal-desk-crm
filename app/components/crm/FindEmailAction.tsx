"use client";
// "Find email" for contacts with no email on file. Spends real Apollo credits,
// so it always confirms first and states the cost plainly. It never fires on
// its own. The enrich route is owned by another lane; this codes against it
// defensively (a calm state for 503 / ApolloNotConfigured, never a crash).
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";

export type EnrichResult = { contactId: number; ok: boolean; email?: string; error?: string };

export default function FindEmailAction({
  contactIds,
  label,
}: {
  contactIds: number[];
  /** Override the trigger label, e.g. "Find email" on a single contact. */
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [results, setResults] = useState<EnrichResult[] | null>(null);

  const n = contactIds.length;

  async function run() {
    setBusy(true);
    setError(null);
    setNotConfigured(false);
    try {
      const res = await fetch("/api/apollo/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds, confirmSpend: true }),
      });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      const code = typeof data?.error === "string" ? data.error : undefined;
      if (res.status === 503 || code === "ApolloNotConfigured") {
        setNotConfigured(true);
        return;
      }
      if (!res.ok) throw new Error(code || "Could not look up these emails");
      setResults((data.results ?? []) as EnrichResult[]);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not look up these emails");
    } finally {
      setBusy(false);
    }
  }

  // Escape closes the dialog unless a lookup is running.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setOpen(false);
        setResults(null);
        setError(null);
        setNotConfigured(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  function close() {
    setOpen(false);
    setResults(null);
    setError(null);
    setNotConfigured(false);
  }

  if (contactIds.length === 0) return null;

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {label ?? `Find email${n > 1 ? `s for ${n} people` : ""}`}
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/40 p-4"
          onClick={() => !busy && close()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="find-email-title"
            className="card w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="find-email-title" className="mb-3 text-[15px] font-semibold text-[var(--ink)]">
              Find email{n > 1 ? `s for ${n} people` : ""}
            </h2>

            {notConfigured ? (
              <>
                <p className="mb-4 text-sm text-[var(--ink-soft)]">Apollo is not connected yet.</p>
                <div className="flex justify-end">
                  <Button variant="secondary" onClick={close}>
                    Close
                  </Button>
                </div>
              </>
            ) : results ? (
              <>
                <ul className="mb-4 max-h-60 space-y-1 overflow-y-auto text-sm">
                  {results.map((r) => (
                    <li key={r.contactId} className={r.ok ? "text-[var(--ink)]" : "text-[var(--ink-faint)]"}>
                      {r.ok ? `Found: ${r.email ?? "email on file"}` : `Not found: ${r.error ?? "no result"}`}
                    </li>
                  ))}
                </ul>
                <div className="flex justify-end">
                  <Button variant="secondary" onClick={close}>
                    Done
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="mb-4 text-sm text-[var(--ink-soft)]">
                  This uses the firm&apos;s Apollo credits: about 1 credit per person, {n} credit{n === 1 ? "" : "s"} total.
                  It also reveals the full surname.
                </p>
                {error && <p className="mb-3 text-sm text-[var(--bad)]">{error}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="quiet" onClick={close} disabled={busy}>
                    Cancel
                  </Button>
                  <Button variant="secondary" onClick={run} disabled={busy}>
                    {busy ? "Looking..." : "Find email"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
