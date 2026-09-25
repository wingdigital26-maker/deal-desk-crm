"use client";
// Touch cadence: "touch this relationship every N days". Today lists everyone
// who has gone quiet longer than their cadence. Logging a touch clears them.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../ui/Button";
import { CADENCE_OPTIONS, cadenceLabel } from "../../lib/cadenceLabels";

export default function TouchCadence({ contactId, value }: { contactId: number; value: number | null }) {
  const router = useRouter();
  const [days, setDays] = useState<number | null>(value);
  const [error, setError] = useState<string | null>(null);

  async function save(next: number | null) {
    const prev = days;
    setDays(next);
    setError(null);
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ touch_every_days: next }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setDays(prev);
      setError("Could not save the reminder.");
      return;
    }
    router.refresh();
  }

  const known = CADENCE_OPTIONS.some((o) => o.value === days);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-sm text-[var(--ink-soft)]" htmlFor={`cadence-${contactId}`}>
        Touch reminder
      </label>
      <select
        id={`cadence-${contactId}`}
        value={days ?? ""}
        onChange={(e) => save(e.target.value ? Number(e.target.value) : null)}
        className="h-[44px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]"
      >
        {!known && days != null && <option value={days}>{cadenceLabel(days)}</option>}
        {CADENCE_OPTIONS.map((o) => (
          <option key={o.label} value={o.value ?? ""}>
            {o.label}
          </option>
        ))}
      </select>
      <LogTouchButton contactId={contactId} />
      {error && <span className="text-xs text-[var(--bad)]">{error}</span>}
    </div>
  );
}

/** One tap: records a touch (a call) on the contact's timeline, which resets its cadence clock. */
export function LogTouchButton({ contactId, companyId, label = "Log a touch" }: { contactId: number; companyId?: number | null; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={busy || done}
      onClick={async () => {
        setBusy(true);
        const res = await fetch("/api/activities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "call", body: "Touch logged", contact_id: contactId, company_id: companyId ?? undefined }),
        }).catch(() => null);
        setBusy(false);
        if (res?.ok) {
          setDone(true);
          router.refresh();
        }
      }}
    >
      {done ? "Logged" : busy ? "Logging..." : label}
    </Button>
  );
}
