"use client";
// Owner-only: re-runs the public-source enrichment for one company. It fetches
// the company site, the TX registry and recent news, so it says how long it
// takes and never fires on its own.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";

export default function RefreshProfileButton({ companyId, refreshedAt }: { companyId: number; refreshedAt: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/profile/refresh`, { method: "POST" });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not refresh this profile");
      const w = (data.result?.writes ?? {}) as Record<string, number>;
      const added = (w.insert ?? 0) + (w.update ?? 0);
      setMsg(added > 0 ? `${added} field${added === 1 ? "" : "s"} added or updated` : "Nothing new in public sources");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not refresh this profile");
    } finally {
      setBusy(false);
    }
  }

  const when = refreshedAt ? new Date(refreshedAt.replace(" ", "T") + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" onClick={run} disabled={busy}>
        {busy ? "Refreshing, about a minute" : "Refresh profile"}
      </Button>
      <span aria-live="polite" className={`text-[12px] ${err ? "text-[var(--bad)]" : "text-[var(--ink-faint)]"}`}>
        {err ?? msg ?? (when ? `Last refreshed ${when}` : "Not refreshed yet")}
      </span>
    </div>
  );
}
