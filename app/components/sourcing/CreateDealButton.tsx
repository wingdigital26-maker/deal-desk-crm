"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "../ui/Button";

export default function CreateDealButton({ companyId, companyName }: { companyId: number; companyName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dealId, setDealId] = useState<number | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/signals/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: companyId, title: `${companyName}: sourcing` }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not create the deal.");
        setBusy(false);
        return;
      }
      setDealId(Number(data.deal_id));
      router.refresh();
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  if (dealId) {
    return (
      <ButtonLink href={`/pipeline/${dealId}`} variant="secondary" size="sm">
        Open deal
      </ButtonLink>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" onClick={onClick} disabled={busy}>
        {busy ? "Creating..." : "Create deal"}
      </Button>
      {error && <span className="max-w-[14rem] text-right text-xs text-[var(--bad)]">{error}</span>}
    </div>
  );
}
