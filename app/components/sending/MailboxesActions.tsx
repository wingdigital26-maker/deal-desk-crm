"use client";
// Add-mailbox form plus the mailbox table's pause/warmup-date controls. Takes
// its rows as a prop from the server page and refreshes via router.refresh()
// after every mutation, instead of holding its own copy fetched on mount.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { FieldInput, inputClass } from "../crm/Field";
import EmptyState from "../crm/EmptyState";
import { Card, mailboxStatusLabel } from "./ui";
import StatusLabel from "../ui/StatusLabel";

export type Mailbox = {
  id: number;
  address: string;
  provider: string;
  warmup_started: string | null;
  paused: number;
  created_at: string;
  domain: string | null;
  daily_cap: number | null;
  todaysCap: number;
};

export default function MailboxesActions({
  mailboxes,
  canPullInstantly = false,
}: {
  mailboxes: Mailbox[];
  canPullInstantly?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState("");
  const [newWarmup, setNewWarmup] = useState("");
  const [newProvider, setNewProvider] = useState("instantly");
  const [newCap, setNewCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function pullFromInstantly() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/outbound/instantly/accounts", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not read mailboxes from Instantly.");
      const skipped = data.skippedNotAllowed || 0;
      setNotice(
        `Instantly lists ${data.fetched} mailbox${data.fetched === 1 ? "" : "es"}: ${data.added} added, ${data.updated} updated` +
          (skipped > 0 ? `, ${skipped} skipped (not one of the firm's sending domains).` : ".")
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read mailboxes from Instantly.");
    } finally {
      setBusy(false);
    }
  }

  async function setDailyCap(m: Mailbox, value: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mailboxes/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyCap: value === "" ? null : Number(value) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not set the daily cap.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not set the daily cap.");
    } finally {
      setBusy(false);
    }
  }

  async function addMailbox(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: newAddress,
          warmupStarted: newWarmup || null,
          provider: newProvider,
          dailyCap: newCap === "" ? null : Number(newCap),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add mailbox.");
      setNewAddress("");
      setNewWarmup("");
      setNewCap("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add mailbox.");
    } finally {
      setBusy(false);
    }
  }

  async function togglePause(m: Mailbox) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mailboxes/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !m.paused }),
      });
      if (!res.ok) throw new Error("Could not update mailbox.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update mailbox.");
    } finally {
      setBusy(false);
    }
  }

  async function setWarmupDate(m: Mailbox, date: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mailboxes/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warmupStarted: date || null }),
      });
      if (!res.ok) throw new Error("Could not set warmup date.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not set warmup date.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && (
        <Card className="mb-4 border border-[color-mix(in_srgb,var(--bad)_35%,transparent)] px-4 py-2">
          <p className="text-sm text-[var(--bad)]">{error}</p>
        </Card>
      )}

      <Card className="mb-6 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-[var(--ink)]">Add a mailbox</h2>
          {canPullInstantly && (
            <Button variant="secondary" size="sm" onClick={pullFromInstantly} disabled={busy}>
              Pull mailboxes from Instantly
            </Button>
          )}
        </div>
        {notice && <p className="mb-3 text-sm text-[var(--ink-soft)]">{notice}</p>}
        <form onSubmit={addMailbox} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <FieldInput label="Address" htmlFor="address">
              <input
                id="address"
                className={inputClass}
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                placeholder="name@sending-domain.com"
                required
              />
            </FieldInput>
          </div>
          <FieldInput label="Sends through" htmlFor="provider">
            <select
              id="provider"
              className={inputClass}
              value={newProvider}
              onChange={(e) => setNewProvider(e.target.value)}
            >
              <option value="instantly">Instantly</option>
              <option value="apollo">Apollo</option>
            </select>
          </FieldInput>
          <FieldInput label="Daily cap (optional)" htmlFor="cap">
            <input
              id="cap"
              type="number"
              min={0}
              max={1000}
              className={`${inputClass} w-[120px]`}
              value={newCap}
              onChange={(e) => setNewCap(e.target.value)}
              placeholder="e.g. 30"
            />
          </FieldInput>
          <FieldInput label="Warmup start (optional)" htmlFor="warmup">
            <input
              id="warmup"
              type="date"
              className={inputClass}
              value={newWarmup}
              onChange={(e) => setNewWarmup(e.target.value)}
            />
          </FieldInput>
          <Button type="submit" disabled={busy}>
            Add mailbox
          </Button>
        </form>
      </Card>

      {mailboxes.length === 0 ? (
        <EmptyState title="No mailboxes yet" detail="Add one above to start its warmup clock." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-[var(--rule)] text-left text-[12px] font-semibold text-[var(--ink-soft)]">
                <th className="px-4 py-2">Address</th>
                <th className="px-4 py-2">Sends through</th>
                <th className="px-4 py-2">Warmup started</th>
                <th className="px-4 py-2">Daily cap</th>
                <th className="px-4 py-2">Today&apos;s allowance</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((m) => (
                <tr key={m.id} className="border-b border-[var(--rule)] last:border-0">
                  <td className="px-4 py-2 text-[var(--ink)]">
                    <div>{m.address}</div>
                    {m.domain && <div className="text-xs text-[var(--ink-faint)]">{m.domain}</div>}
                  </td>
                  <td className="px-4 py-2 text-[var(--ink-soft)]">{m.provider === "instantly" ? "Instantly" : "Apollo"}</td>
                  <td className="px-4 py-2">
                    <input
                      type="date"
                      defaultValue={m.warmup_started ?? ""}
                      onBlur={(e) => {
                        if (e.target.value !== (m.warmup_started ?? "")) setWarmupDate(m, e.target.value);
                      }}
                      className={inputClass}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      aria-label={`Daily cap for ${m.address}`}
                      defaultValue={m.daily_cap ?? ""}
                      placeholder="None"
                      onBlur={(e) => {
                        if (e.target.value !== String(m.daily_cap ?? "")) setDailyCap(m, e.target.value);
                      }}
                      className={`${inputClass} w-[96px]`}
                    />
                  </td>
                  <td className="numeric px-4 py-2 text-[var(--ink)]">{m.paused ? 0 : m.todaysCap}</td>
                  <td className="px-4 py-2">
                    {(() => {
                      const s = mailboxStatusLabel(!!m.paused, m.warmup_started);
                      return <StatusLabel kind={s.kind}>{s.text}</StatusLabel>;
                    })()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button variant="secondary" size="sm" onClick={() => togglePause(m)} disabled={busy}>
                      {m.paused ? "Unpause" : "Pause"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
