"use client";
// Approve / reject actions. Server routes are the real gate (separation of
// duties, role check); this just reflects that gate in the UI so a blocked
// action is obvious rather than a surprise 403.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import StatusLabel from "../ui/StatusLabel";
import { inputClass } from "../crm/Field";

export default function ApprovalActions({
  templateId,
  canApprove,
  canReject,
  blockedReason,
  approverNote,
}: {
  templateId: number;
  canApprove: boolean;
  canReject: boolean;
  blockedReason?: string;
  approverNote: string;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/templates/${templateId}/approve`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Approve failed");
        return;
      }
      router.push("/outbound/approvals");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!note.trim()) {
      setError("A note explaining what to fix is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/templates/${templateId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Send back failed");
        return;
      }
      router.push("/outbound/approvals");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--ink-soft)]">{approverNote}</p>
      {blockedReason && <StatusLabel kind="info">{blockedReason}</StatusLabel>}
      {error && <p className="text-sm text-[var(--bad)]">{error}</p>}

      <div className="flex flex-wrap gap-3">
        {canApprove && (
          <Button type="button" variant="accent" onClick={approve} disabled={busy}>
            Approve this content
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={() => setRejecting((v) => !v)} disabled={!canReject || busy}>
          Send back with a note
        </Button>
      </div>

      {rejecting && (
        <div className="space-y-2">
          <label className="block text-sm text-[var(--ink-soft)]">What needs to change (required)</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={inputClass} />
          <Button type="button" variant="secondary" onClick={reject} disabled={busy}>
            {busy ? "Sending back..." : "Confirm send back"}
          </Button>
        </div>
      )}
    </div>
  );
}
