"use client";
// Minimal create form. The full editing experience lives in TemplateEditor
// once the template exists (it needs an id to save/submit against).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { firm } from "../../../firm.config";
import { Button } from "../ui/Button";

export default function NewTemplateForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState(firm.segments[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          segmentId,
          subject: "Subject line",
          bodyText: "Message body",
          allowedMergeFields: [],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not create template");
        return;
      }
      router.push(`/outbound/templates/${data.id}`);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        New template
      </Button>
    );
  }

  return (
    <form onSubmit={create} className="card flex flex-wrap items-end gap-3 p-4">
      <div>
        <label className="mb-1 block text-[12px] font-semibold text-[var(--ink-soft)]">Name</label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-h-[44px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-[12px] font-semibold text-[var(--ink-soft)]">Segment</label>
        <select
          value={segmentId}
          onChange={(e) => setSegmentId(e.target.value)}
          className="min-h-[44px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-sm"
        >
          {firm.segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-sm text-[var(--bad)]">{error}</p>}
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? "Creating..." : "Create"}
      </Button>
      <Button type="button" variant="quiet" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}
