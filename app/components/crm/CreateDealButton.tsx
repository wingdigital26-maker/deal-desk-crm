"use client";
// Creates a deal in place for a company (stage "Sourced", title defaulting to
// the company name), then links straight to it. Used from the deals empty
// state on /companies/[id].
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";

export default function CreateDealButton({ companyId, companyName }: { companyId: number; companyName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: companyId, title: companyName, stage: "Sourced" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not open a deal");
      router.push(`/pipeline/${data.item.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open a deal");
      setBusy(false);
    }
  }

  return (
    <div>
      <Button onClick={create} disabled={busy}>
        {busy ? "Opening deal..." : "Open a deal"}
      </Button>
      {error && <p className="mt-2 text-xs text-[var(--bad)]">{error}</p>}
    </div>
  );
}
