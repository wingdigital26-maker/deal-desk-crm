"use client";
// Pipeline as a list, organized like a relationship-CRM deal list: company, primary contact, numbered stage, outcome, notes,
// last interaction with a quick "+" to log one, location. Deal Desk styling.
import { useMemo, useState } from "react";
import Link from "next/link";
import { inputClass } from "../crm/Field";
import ExportLinks from "../crm/ExportLinks";
import { BuildingIcon } from "../ui/icons";
import { PeopleLine } from "./DealCard";
import type { Deal } from "./types";

type SortKey = "company" | "contact" | "stage" | "interaction" | "location";

const selectClass =
  "h-[44px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]";

const shortDate = (s: string | null | undefined) =>
  s ? new Date(s.replace(" ", "T") + (s.length > 10 ? "Z" : "T00:00:00")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "-";

const location = (d: Deal) => [d.company_city, d.company_state].filter(Boolean).join(", ");

export default function PipelineList({
  deals,
  stages,
  onMove,
  onPatch,
  onNoted,
}: {
  deals: Deal[];
  stages: readonly string[];
  onMove: (dealId: number, stage: string) => void;
  onPatch: (dealId: number, patch: Partial<Deal>) => Promise<boolean>;
  onNoted: (dealId: number, body: string) => void;
}) {
  const [q, setQ] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "stage", dir: 1 });
  const [editing, setEditing] = useState<{ id: number; field: "outcome" | "note" } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const stageNo = (s: string) => stages.indexOf(s) + 1;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = deals.filter(
      (d) =>
        (!stageFilter || d.stage === stageFilter) &&
        (!needle ||
          [d.company_name, d.primary_contact_name, d.title, d.outcome, d.last_note, d.known_names].some((x) => x?.toLowerCase().includes(needle)))
    );
    const val = (d: Deal): string | number => {
      switch (sort.key) {
        case "company":
          return d.company_name.toLowerCase();
        case "contact":
          return (d.primary_contact_name || "~").toLowerCase();
        case "stage":
          return stageNo(d.stage);
        case "interaction":
          return d.last_interaction_at ?? "";
        case "location":
          return location(d).toLowerCase() || "~";
      }
    };
    return [...filtered].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : a.company_name.localeCompare(b.company_name)) * sort.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deals, q, stageFilter, sort]);

  function header(key: SortKey, label: string) {
    const active = sort.key === key;
    return (
      <button
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
        className="inline-flex min-h-[40px] items-center gap-1 whitespace-nowrap font-semibold text-[var(--ink)]"
        aria-label={`Sort by ${label}`}
      >
        {label}
        <span className={`text-[11px] ${active ? "text-[var(--accent-deep)]" : "text-[var(--ink-faint)]"}`} aria-hidden>
          {active ? (sort.dir === 1 ? "▲" : "▼") : "↕"}
        </span>
      </button>
    );
  }

  async function commit(d: Deal) {
    if (!editing) return;
    const text = draft.trim();
    setError(null);
    if (editing.field === "outcome") {
      if (text !== (d.outcome ?? "")) {
        const ok = await onPatch(d.id, { outcome: text || null });
        if (!ok) setError("Could not save the outcome.");
      }
    } else if (text) {
      const res = await fetch("/api/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "note", body: text, deal_id: d.id, company_id: d.company_id }),
      }).catch(() => null);
      if (res?.ok) onNoted(d.id, text);
      else setError("Could not save the note.");
    }
    setEditing(null);
    setDraft("");
  }

  function inlineInput(d: Deal, label: string) {
    return (
      <input
        autoFocus
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(d)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(d);
          if (e.key === "Escape") setEditing(null);
        }}
        placeholder={label}
        className="h-9 w-full rounded-[8px] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm"
      />
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Quick search" aria-label="Quick search deals" className={`${inputClass} max-w-[260px]`} />
        <select aria-label="Filter by stage" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className={selectClass}>
          <option value="">All stages</option>
          {stages.map((s, i) => (
            <option key={s} value={s}>
              {i + 1} - {s}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <ExportLinks entity="deals" />
        <span className="numeric text-sm text-[var(--ink-soft)]">
          {rows.length === 0 ? 0 : 1} - {rows.length} of {deals.length}
        </span>
      </div>
      {error && <div className="mb-2 text-sm text-[var(--bad)]">{error}</div>}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[1080px] text-sm">
          <thead>
            <tr className="border-b border-[var(--rule-strong)] text-left text-[13px]">
              <th className="py-1 pl-4 pr-3">{header("company", "Company")}</th>
              <th className="py-1 pr-3">{header("contact", "Primary contact")}</th>
              <th className="py-1 pr-3">{header("stage", "Stage")}</th>
              <th className="py-1 pr-3 font-semibold text-[var(--ink)]">Outcome</th>
              <th className="py-1 pr-3 font-semibold text-[var(--ink)]">Notes</th>
              <th className="py-1 pr-3">{header("interaction", "Last interaction")}</th>
              <th className="py-1 pr-4">{header("location", "Location")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="border-b border-[var(--rule)] align-top last:border-0 hover:bg-[var(--paper)]">
                <td className="py-3 pl-4 pr-3">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-[var(--paper-deep)] text-[var(--ink-soft)]" aria-hidden>
                      <BuildingIcon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <Link href={`/pipeline/${d.id}`} className="block max-w-[220px] truncate font-semibold text-[var(--accent-deep)] hover:underline" title={d.company_name}>
                        {d.company_name}
                      </Link>
                      <PeopleLine deal={d} />
                    </div>
                  </div>
                </td>
                <td className="py-3 pr-3">
                  {d.primary_contact_id && d.primary_contact_name ? (
                    <Link href={`/contacts/${d.primary_contact_id}`} className="text-[var(--ink)] hover:underline">
                      {d.primary_contact_name}
                    </Link>
                  ) : (
                    <span className="text-[var(--ink-faint)]">-</span>
                  )}
                  {d.primary_contact_title && <div className="text-[12px] text-[var(--ink-soft)]">{d.primary_contact_title}</div>}
                </td>
                <td className="py-3 pr-3">
                  <select
                    aria-label={`Stage for ${d.company_name}`}
                    value={d.stage}
                    onChange={(e) => onMove(d.id, e.target.value)}
                    className="h-9 max-w-[170px] rounded-[8px] border border-transparent bg-transparent px-1 text-sm text-[var(--ink)] hover:border-[var(--rule-strong)]"
                  >
                    {stages.map((s, i) => (
                      <option key={s} value={s}>
                        {i + 1} - {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="max-w-[260px] py-3 pr-3">
                  {editing?.id === d.id && editing.field === "outcome" ? (
                    inlineInput(d, "Outcome, e.g. Pass - too concentrated")
                  ) : (
                    <button
                      onClick={() => {
                        setEditing({ id: d.id, field: "outcome" });
                        setDraft(d.outcome ?? "");
                      }}
                      className="line-clamp-2 min-h-[36px] w-full text-left text-[var(--ink)]"
                      title={d.outcome ?? "Add an outcome"}
                    >
                      {d.outcome || <span className="text-[var(--ink-faint)]">-</span>}
                    </button>
                  )}
                </td>
                <td className="max-w-[240px] py-3 pr-3">
                  {editing?.id === d.id && editing.field === "note" ? (
                    inlineInput(d, "Add a note")
                  ) : (
                    <span className="line-clamp-2 text-[var(--ink-soft)]" title={d.last_note ?? ""}>
                      {d.last_note || <span className="text-[var(--ink-faint)]">-</span>}
                    </span>
                  )}
                </td>
                <td className="py-3 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="numeric whitespace-nowrap text-[var(--ink)]">{shortDate(d.last_interaction_at)}</span>
                    <button
                      onClick={() => {
                        setEditing({ id: d.id, field: "note" });
                        setDraft("");
                      }}
                      aria-label={`Log an interaction with ${d.company_name}`}
                      title="Log an interaction"
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] border border-[var(--rule-strong)] text-[18px] leading-none text-[var(--ink)] hover:bg-[var(--surface)]"
                    >
                      +
                    </button>
                  </div>
                </td>
                <td className="py-3 pr-4 text-[var(--ink-soft)]">{location(d) || "-"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-[var(--ink-soft)]">
                  No deals match that search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
