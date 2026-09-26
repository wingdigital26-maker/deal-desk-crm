"use client";
// IOI / LOI terms grid: every bidder side by side, one column per buyer, one
// row per term, so the banker can compare bids the way a bid summary reads.
// Edits save per cell and log the old value (deal_buyer_revisions).
import { useState } from "react";
import Link from "next/link";
import EmptyState from "../crm/EmptyState";
import { formatMoney, parseMoney } from "../../lib/dealMath";
import type { BuyerRow } from "../../lib/buyers";
import { stageText } from "./format";

type Kind = "money" | "pct" | "days" | "text";
const ROWS: { key: keyof BuyerRow; label: string; kind: Kind }[] = [
  { key: "ioi_low", label: "IOI low", kind: "money" },
  { key: "ioi_high", label: "IOI high", kind: "money" },
  { key: "loi_value", label: "LOI value", kind: "money" },
  { key: "cash_at_close_pct", label: "Cash at close %", kind: "pct" },
  { key: "rollover_pct", label: "Rollover %", kind: "pct" },
  { key: "earnout", label: "Earnout", kind: "text" },
  { key: "financing", label: "Financing", kind: "text" },
  { key: "diligence_days", label: "Diligence (days)", kind: "days" },
  { key: "exclusivity_days", label: "Exclusivity (days)", kind: "days" },
  { key: "structure_notes", label: "Structure notes", kind: "text" },
];

function display(v: unknown, kind: Kind): string {
  if (v == null || v === "") return "";
  if (kind === "money") return formatMoney(Number(v));
  if (kind === "pct") return `${v}%`;
  return String(v);
}

function toValue(text: string, kind: Kind): number | string | null | typeof NaN {
  const t = text.trim();
  if (!t) return null;
  if (kind === "money") return parseMoney(t);
  if (kind === "pct" || kind === "days") return Number(t.replace("%", ""));
  return t;
}

export default function TermsGrid({ buyers, onSave }: { buyers: BuyerRow[]; onSave: (id: number, patch: Record<string, unknown>) => Promise<boolean> }) {
  const [editing, setEditing] = useState<{ id: number; key: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);

  if (!buyers.length) {
    return <EmptyState title="No bids yet" detail="Buyers show up here once they reach the IOI stage. Move a buyer to IOI to start the grid." />;
  }

  // Highest headline value first: LOI if there is one, else the top of the IOI range.
  const sorted = [...buyers].sort((a, b) => (b.loi_value ?? b.ioi_high ?? b.ioi_low ?? 0) - (a.loi_value ?? a.ioi_high ?? a.ioi_low ?? 0));
  const best = Math.max(0, ...sorted.map((b) => b.loi_value ?? b.ioi_high ?? 0));

  async function commit(b: BuyerRow, key: string, kind: Kind) {
    const value = toValue(draft, kind);
    if (typeof value === "number" && Number.isNaN(value)) {
      setBad(true);
      return;
    }
    if ((b[key as keyof BuyerRow] ?? null) !== value) await onSave(b.id, { [key]: value });
    setEditing(null);
    setBad(false);
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-[var(--surface)] py-2 pr-4 text-left text-[12px] font-semibold text-[var(--ink-soft)]">Term</th>
            {sorted.map((b) => (
              <th key={b.id} className="min-w-[160px] border-l border-[var(--rule)] px-3 py-2 text-left align-bottom">
                <Link href={`/companies/${b.buyer_company_id}`} className="block font-bold text-[var(--ink)] hover:underline">
                  {b.buyer_name}
                </Link>
                <span className="text-[11px] font-medium text-[var(--ink-soft)]">{stageText(b)}</span>
                {best > 0 && (b.loi_value ?? b.ioi_high ?? 0) === best && <span className="ml-1 rounded-full bg-[var(--tint-2)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ink)]">Top bid</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="sticky left-0 z-10 border-t border-[var(--rule)] bg-[var(--surface)] py-2 pr-4 text-left text-[13px] font-medium text-[var(--ink)]">
                {r.label}
              </th>
              {sorted.map((b) => {
                const isEditing = editing?.id === b.id && editing.key === r.key;
                const v = b[r.key];
                return (
                  <td key={b.id} className="border-l border-t border-[var(--rule)] px-3 py-1.5 align-top">
                    {isEditing ? (
                      <input
                        autoFocus
                        aria-label={`${r.label} for ${b.buyer_name}`}
                        value={draft}
                        onChange={(e) => {
                          setDraft(e.target.value);
                          setBad(false);
                        }}
                        onBlur={() => commit(b, r.key, r.kind)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commit(b, r.key, r.kind);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        className={`h-9 w-full rounded-[8px] border px-2 text-sm ${bad ? "border-[var(--bad)]" : "border-[var(--rule-strong)]"}`}
                      />
                    ) : (
                      <button
                        onClick={() => {
                          setEditing({ id: b.id, key: r.key });
                          setDraft(v == null ? "" : r.kind === "money" ? Number(v).toLocaleString("en-US") : String(v));
                        }}
                        className="numeric min-h-[36px] w-full rounded-[8px] px-1 text-left text-[var(--ink)] hover:bg-[var(--paper)]"
                        aria-label={`Edit ${r.label} for ${b.buyer_name}`}
                      >
                        {display(v, r.kind) || <span className="text-[var(--ink-faint)]">Add</span>}
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[12px] text-[var(--ink-faint)]">Click any cell to edit. Money takes 12.5M, 750K or 1,200,000. Every change is kept with its old value.</p>
    </div>
  );
}
