"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function DoNotContactToggle({ contactId, value }: { contactId: number; value: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ do_not_contact: !value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not update this contact");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this contact");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={toggle}
        disabled={busy}
        className={`inline-flex min-h-[44px] items-center rounded-[var(--radius)] border px-3.5 text-sm font-medium disabled:opacity-50 ${
          value
            ? "border-[var(--bad)] bg-[var(--bad)]/10 text-[var(--bad)] hover:bg-[var(--bad)]/15"
            : "border-[var(--rule-strong)] bg-[var(--surface)] hover:bg-[var(--paper)]"
        }`}
      >
        {value ? "Do not contact: ON" : "Mark do not contact"}
      </button>
      {value && <p className="mt-1 text-xs text-[var(--ink-faint)]">Blocked from all outbound. This email was added to the do-not-contact list.</p>}
      {error && <p className="mt-1 text-xs text-[var(--bad)]">{error}</p>}
    </div>
  );
}
