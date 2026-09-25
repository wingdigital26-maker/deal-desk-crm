"use client";
// Shared confirm step for a destructive action. role=dialog, Escape cancels,
// focus starts on Cancel so an accidental Enter never confirms.
import { useEffect, useRef } from "react";
import { Button } from "./Button";

export default function ConfirmDialog({
  titleId,
  title,
  detail,
  confirmLabel,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: {
  titleId: string;
  title: string;
  detail: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 py-10 md:items-center"
    >
      <div className="card w-full max-w-md p-5">
        <h2 id={titleId} className="display text-lg text-[var(--ink)]">
          {title}
        </h2>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">{detail}</p>
        {error && <p className="mt-3 text-sm text-[var(--bad)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Deleting..." : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
