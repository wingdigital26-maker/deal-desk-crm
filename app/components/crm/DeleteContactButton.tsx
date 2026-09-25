"use client";
// Owner-only destructive action for a contact. Self-contained: the profile
// page mounts this with a single line and nothing else changes here when
// the profile layout around it changes.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";

export default function DeleteContactButton({ contactId, contactName }: { contactId: number; contactName: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contactId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not delete this contact.");
        return;
      }
      router.push("/contacts");
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
        Delete contact
      </Button>
      {confirming && (
        <ConfirmDialog
          titleId="delete-contact-title"
          title={`Delete the contact "${contactName}"?`}
          detail="Their tasks and timeline notes go with them. Any draft or queued messages to them are removed too. Deals they are linked to stay, just without a primary contact. Emails already sent to them are kept on record and are never deleted."
          confirmLabel="Delete contact"
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
