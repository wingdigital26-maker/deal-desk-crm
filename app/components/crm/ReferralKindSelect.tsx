"use client";
// Marks a contact as a referral source (CPA, attorney, wealth manager ...).
// Anyone with a kind shows on Contacts > Referral sources with their credit.
import { useState } from "react";
import { useRouter } from "next/navigation";
import Select from "../ui/Select";
import { REFERRAL_KINDS, referralKindLabel } from "../../lib/referralKinds";

export default function ReferralKindSelect({ contactId, value }: { contactId: number; value: string | null }) {
  const router = useRouter();
  const [kind, setKind] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);

  async function save(next: string) {
    const prev = kind;
    setKind(next);
    setError(null);
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referral_kind: next || null }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setKind(prev);
      setError("Could not save.");
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <Select id={`referral-kind-${contactId}`} label="Referral source" value={kind} onChange={(e) => save(e.target.value)}>
        <option value="">Not a referral source</option>
        {REFERRAL_KINDS.map((k) => (
          <option key={k} value={k}>
            {referralKindLabel(k)}
          </option>
        ))}
      </Select>
      {error && <p className="mt-1 text-xs text-[var(--bad)]">{error}</p>}
    </div>
  );
}
