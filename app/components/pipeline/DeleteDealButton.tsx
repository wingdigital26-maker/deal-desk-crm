"use client";
// Quiet, owner-only destructive action for a deal. Not the filled action on
// the page: secondary/danger styling, confirm-gated, one clean redirect.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";

export default function DeleteDealButton({ dealId, dealTitle }: { dealId: number; dealTitle: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not delete this deal.");
        return;
      }
      router.push("/pipeline");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
        Delete deal
      </Button>
      {confirming && (
        <ConfirmDialog
          titleId="delete-deal-title"
          title={`Delete the deal "${dealTitle}"?`}
          detail="Its tasks and timeline notes go with it. The audit trail keeps a record."
          confirmLabel="Delete deal"
          busy={busy}
          error={error}
          onCancel={() => {
            setConfirming(false);
            setError(null);
          }}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
