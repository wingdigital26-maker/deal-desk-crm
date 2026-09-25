"use client";
// Filter bar for the ranked signals table. Reads/writes the URL query string
// so the filtered view is a server-rendered page, not client-only state.
import { useRouter, useSearchParams } from "next/navigation";
import type { Segment } from "../../../firm.config";
import Select from "../ui/Select";
import DateInput from "../ui/DateInput";

const KINDS = [
  { value: "", label: "All kinds" },
  { value: "hiring", label: "Hiring" },
  { value: "news", label: "News" },
  { value: "filing", label: "SEC filing" },
  { value: "contract", label: "Federal contract" },
];

export default function SignalsFilters({ segments }: { segments: readonly Segment[] }) {
  const router = useRouter();
  const params = useSearchParams();

  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/sourcing/signals${next.toString() ? `?${next.toString()}` : ""}`);
  }

  return (
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <Select
        aria-label="Filter by segment"
        wrapperClassName="w-[170px]"
        value={params.get("segment") || ""}
        onChange={(e) => update("segment", e.target.value)}
      >
        <option value="">All segments</option>
        {segments.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Filter by signal kind"
        wrapperClassName="w-[160px]"
        value={params.get("kind") || ""}
        onChange={(e) => update("kind", e.target.value)}
      >
        {KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </Select>

      <input
        aria-label="Minimum signal score"
        type="number"
        min={0}
        step={0.5}
        placeholder="Min score"
        className="h-[44px] w-28 rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-[16px] text-[var(--ink)] outline-none focus-visible:border-[var(--accent)]"
        // Remount when the URL changes so "Clear filters" empties the box.
        key={`min-${params.get("min_score") ?? ""}`}
        defaultValue={params.get("min_score") || ""}
        onBlur={(e) => {
          if (e.target.value !== (params.get("min_score") || "")) update("min_score", e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") update("min_score", e.currentTarget.value);
        }}
      />

      <DateInput
        aria-label="Signals since date"
        wrapperClassName="w-[170px]"
        key={`since-${params.get("since") ?? ""}`}
        defaultValue={params.get("since") || ""}
        onChange={(e) => update("since", e.target.value)}
      />

      {(params.get("segment") || params.get("kind") || params.get("min_score") || params.get("since")) && (
        <button
          type="button"
          onClick={() => router.push("/sourcing/signals")}
          className="h-[44px] text-sm text-[var(--ink)] underline underline-offset-2 decoration-[var(--rule-strong)] hover:decoration-[var(--ink)]"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
