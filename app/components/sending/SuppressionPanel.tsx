"use client";
// Do-not-contact list management. Anyone signed in can add an entry (e.g.
// after a bounce); removal re-enables sending to that address, so it is
// owner-only and the API enforces that independently of this UI. Takes its
// initial list as a prop so there is no fetch-on-mount effect.
import { useState } from "react";
import { Button } from "../ui/Button";
import { FieldInput, inputClass as crmInputClass } from "../crm/Field";
import EmptyState from "../crm/EmptyState";
import { Card } from "./ui";
import type { SessionUser } from "../../lib/session";

type Entry = { email: string; reason: string; created_at: string };

export default function SuppressionPanel({ user, initialEntries }: { user: SessionUser; initialEntries: Entry[] }) {
  const [entries, setEntries] = useState<Entry[]>(initialEntries);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      const res = await fetch("/api/suppression");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the do-not-contact list.");
      setEntries(data.suppression);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the do-not-contact list.");
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/suppression", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add.");
      setEmail("");
      setReason("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(entryEmail: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/suppression/${encodeURIComponent(entryEmail)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not remove.");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <div className="border-b border-[var(--rule)] px-4 py-3">
        <h2 className="text-sm font-medium text-[var(--ink)]">Do-not-contact list</h2>
        <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
          Nobody on this list can be sent to, regardless of any other check.
        </p>
      </div>

      <form onSubmit={add} className="flex flex-wrap items-end gap-3 border-b border-[var(--rule)] px-4 py-3">
        <div className="min-w-[200px] flex-1">
          <FieldInput label="Email" htmlFor="supp-email">
            <input id="supp-email" className={crmInputClass} value={email} onChange={(e) => setEmail(e.target.value)} required />
          </FieldInput>
        </div>
        <div className="min-w-[200px] flex-1">
          <FieldInput label="Reason" htmlFor="supp-reason">
            <input
              id="supp-reason"
              className={crmInputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="bounced, unsubscribed, requested no contact"
              required
            />
          </FieldInput>
        </div>
        <Button type="submit" variant="secondary" disabled={busy}>
          Add
        </Button>
      </form>

      {error && <p className="px-4 py-2 text-sm text-[var(--bad)]">{error}</p>}

      {entries.length === 0 ? (
        <div className="p-4">
          <EmptyState title="Nothing on the do-not-contact list" detail="Addresses added here can never be sent to." />
        </div>
      ) : (
        <ul className="divide-y divide-[var(--rule)]">
          {entries.map((entry) => (
            <li key={entry.email} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="break-all text-[var(--ink)]">{entry.email}</div>
                <div className="break-words text-xs text-[var(--ink-soft)]">{entry.reason}</div>
              </div>
              {user.role === "owner" && (
                <Button variant="secondary" size="sm" onClick={() => remove(entry.email)} disabled={busy}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
