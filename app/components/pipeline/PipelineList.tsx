"use client";
// Pipeline as a list, organized like a relationship-CRM deal list: company, primary contact, numbered stage, outcome, notes,
// last interaction with a quick "+" to log one, location. Deal Desk styling.
// Each row carries at most ONE attention label (app/lib/attention.ts); closed
// and passed deals are dimmed and sorted after open ones. On a phone the table
// becomes cards instead of a sideways-scrolling table.
import { useMemo, useState } from "react";
import Link from "next/link";
import { inputClass } from "../crm/Field";
import ExportLinks from "../crm/ExportLinks";
import VoiceNoteButton from "../crm/VoiceNoteButton";
import { PeopleLine } from "./DealCard";
import AttentionLabel from "./AttentionLabel";
import { attention, attentionSummary, type Attention, type AttentionKind } from "../../lib/attention";
import type { Deal } from "./types";

type SortKey = "company" | "contact" | "stage" | "interaction" | "location";

const selectClass =
  "h-[44px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]";

const shortDate = (s: string | null | undefined) =>
  s ? new Date(s.replace(" ", "T") + (s.length > 10 ? "Z" : "T00:00:00")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "-";

// A code-named deal leads with "Project Juniper" and names the real company on
// the line under it (everyone here can see the deal). With "Show code names" on,
// company_name is already the code name and the real one is gone (maskDeal).
const codeLabel = (d: Deal) => (d.code_name?.trim() ? d.code_name.trim() : d.company_name);
const realCompany = (d: Deal) => (d.code_name?.trim() && !d.masked ? d.company_name : null);

const location = (d: Deal) => [d.company_city, d.company_state].filter(Boolean).join(", ");

export default function PipelineList({
  deals,
  stages,
  closedStages = [],
  onMove,
  onPatch,
  onNoted,
}: {
  deals: Deal[];
  stages: readonly string[];
  closedStages?: readonly string[];
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
  const [attnFilter, setAttnFilter] = useState<AttentionKind | null>(null);

  const attn = useMemo(() => {
    const m = new Map<number, Attention>();
    for (const d of deals) m.set(d.id, attention(d, closedStages));
    return m;
  }, [deals, closedStages]);
  const summary = useMemo(() => attentionSummary([...attn.values()]), [attn]);

  const stageNo = (s: string) => stages.indexOf(s) + 1;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = deals.filter(
      (d) =>
        (!stageFilter || d.stage === stageFilter) &&
        (!attnFilter || attn.get(d.id)?.label?.kind === attnFilter) &&
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
    // Open deals first, closed and passed after, for every sort except stage
    // (whose own order already ends with them).
    const closedRank = (d: Deal) => (sort.key !== "stage" && attn.get(d.id)?.closed ? 1 : 0);
    return [...filtered].sort((a, b) => {
      const c = closedRank(a) - closedRank(b);
      if (c) return c;
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : a.company_name.localeCompare(b.company_name)) * sort.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deals, q, stageFilter, sort, attn, attnFilter]);

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
    const box = (
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
        className="h-11 w-full rounded-[8px] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm md:h-9"
      />
    );
    if (editing?.field !== "note") return box;
    return (
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">{box}</div>
        <VoiceNoteButton value={draft} onChange={setDraft} />
      </div>
    );
  }

  const summaryParts: { kind: AttentionKind; n: number; text: string }[] = [
    { kind: "overdue" as const, n: summary.overdue, text: `${summary.overdue} overdue` },
    { kind: "quiet" as const, n: summary.quiet, text: `${summary.quiet} quiet` },
    { kind: "due-today" as const, n: summary.dueToday, text: `${summary.dueToday} due today` },
  ].filter((p) => p.n > 0);

  const contactLine = (d: Deal) =>
    d.primary_contact_id && d.primary_contact_name ? (
      <div className="min-w-0 truncate" title={[d.primary_contact_name, d.primary_contact_title].filter(Boolean).join(", ")}>
        <Link href={`/contacts/${d.primary_contact_id}`} className="text-[var(--ink)] hover:underline">
          {d.primary_contact_name}
        </Link>
        {d.primary_contact_title && <span className="text-[12px] text-[var(--ink-faint)]"> · {d.primary_contact_title}</span>}
      </div>
    ) : (
      <span className="text-[var(--ink-faint)]">-</span>
    );

  const stageSelect = (d: Deal, a: Attention | undefined, cls: string) => (
    <select
      aria-label={`Stage for ${d.company_name}`}
      value={d.stage}
      onChange={(e) => onMove(d.id, e.target.value)}
      className={`${cls} rounded-[8px] border border-transparent bg-transparent px-1 text-sm hover:border-[var(--rule-strong)] ${
        a?.late ? "font-semibold text-[var(--accent-deep)]" : a?.closed ? "text-[var(--ink-soft)]" : "text-[var(--ink)]"
      }`}
    >
      {stages.map((s, i) => (
        <option key={s} value={s}>
          {i + 1} - {s}
        </option>
      ))}
    </select>
  );

  const lastInteraction = (d: Deal, a: Attention | undefined) => (
    <span
      className={`numeric whitespace-nowrap ${a?.quiet ? "font-semibold text-[var(--warn)]" : a?.closed ? "text-[var(--ink-soft)]" : "text-[var(--ink)]"}`}
      title={a?.quiet && a.quietDays != null ? `No interaction in ${a.quietDays} days` : undefined}
    >
      {shortDate(d.last_interaction_at)}
    </span>
  );

  const plusButton = (d: Deal, cls: string) => (
    <button
      onClick={() => {
        setEditing({ id: d.id, field: "note" });
        setDraft("");
      }}
      aria-label={`Log an interaction with ${d.company_name}`}
      title="Log an interaction"
      className={`${cls} grid shrink-0 place-items-center rounded-[8px] border border-[var(--rule-strong)] text-[18px] leading-none text-[var(--ink)] hover:bg-[var(--surface)]`}
    >
      +
    </button>
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
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

      <div className="mb-2 flex min-h-[44px] flex-wrap items-center gap-x-1 gap-y-1 text-sm" role="group" aria-label="Deals that need attention">
        {summaryParts.length === 0 ? (
          <span className="text-[var(--ink-soft)]">Nothing overdue or quiet. Every open deal has a current next step and a recent interaction.</span>
        ) : (
          <>
            <span className="font-semibold text-[var(--ink)]">Needs attention:</span>
            {summaryParts.map((p, i) => (
              <span key={p.kind} className="inline-flex items-center">
                <button
                  onClick={() => setAttnFilter((cur) => (cur === p.kind ? null : p.kind))}
                  aria-pressed={attnFilter === p.kind}
                  title={attnFilter === p.kind ? "Show every deal" : `Show only the ${p.text} deals`}
                  className={`min-h-[44px] rounded-[var(--radius-sm)] px-1.5 font-semibold underline decoration-[var(--rule-strong)] underline-offset-4 hover:bg-[var(--paper)] ${
                    attnFilter === p.kind
                      ? "bg-[var(--paper-deep)] text-[var(--ink)]"
                      : p.kind === "overdue"
                        ? "text-[var(--bad)]"
                        : p.kind === "quiet"
                          ? "text-[var(--warn)]"
                          : "text-[var(--ink)]"
                  }`}
                >
                  {p.text}
                </button>
                {i < summaryParts.length - 1 && <span className="-ml-1 mr-0.5 text-[var(--ink-soft)]">,</span>}
              </span>
            ))}
            {attnFilter && (
              <button onClick={() => setAttnFilter(null)} className="min-h-[44px] px-2 text-[13px] text-[var(--ink-soft)] underline hover:text-[var(--ink)]">
                Show all deals
              </button>
            )}
          </>
        )}
      </div>
      {error && <div className="mb-2 text-sm text-[var(--bad)]">{error}</div>}

      {/* Desktop and tablet: the table. Fixed layout so nothing pushes it sideways. */}
      <div className="card hidden overflow-x-auto p-0 md:block">
        <table className="w-full min-w-[900px] table-fixed text-sm">
          <colgroup>
            <col className="w-[25%]" />
            <col className="w-[15%]" />
            <col className="w-[9.5rem]" />
            <col className="w-[11%]" />
            <col className="w-[12%]" />
            <col className="w-[9.5rem]" />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b border-[var(--rule-strong)] text-left text-[13px]">
              <th className="py-0.5 pl-4 pr-3">{header("company", "Company")}</th>
              <th className="py-0.5 pr-3">{header("contact", "Primary contact")}</th>
              <th className="py-0.5 pr-3">{header("stage", "Stage")}</th>
              <th className="py-0.5 pr-3 font-semibold text-[var(--ink)]">Outcome</th>
              <th className="py-0.5 pr-3 font-semibold text-[var(--ink)]">Notes</th>
              <th className="py-0.5 pr-3">{header("interaction", "Last interaction")}</th>
              <th className="py-0.5 pr-4">{header("location", "Location")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const a = attn.get(d.id);
              return (
                <tr
                  key={d.id}
                  className={`border-b border-[var(--rule)] align-middle last:border-0 hover:bg-[var(--paper)] ${a?.closed ? "text-[var(--ink-soft)]" : ""}`}
                >
                  <td className="py-1.5 pl-4 pr-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link
                        href={`/pipeline/${d.id}`}
                        className={`min-w-0 truncate font-semibold hover:underline ${a?.closed ? "text-[var(--ink-soft)]" : "text-[var(--accent-deep)]"}`}
                        title={realCompany(d) ? `${codeLabel(d)} (${realCompany(d)})` : codeLabel(d)}
                      >
                        {codeLabel(d)}
                      </Link>
                      <AttentionLabel a={a} />
                    </div>
                    <PeopleLine deal={d} oneLine prefix={realCompany(d)} />
                  </td>
                  <td className="py-1.5 pr-3">{contactLine(d)}</td>
                  <td className="py-1.5 pr-3">{stageSelect(d, a, "h-9 w-full")}</td>
                  <td className="py-1.5 pr-3">
                    {d.masked ? (
                      <span className="text-[var(--ink-faint)]">-</span>
                    ) : editing?.id === d.id && editing.field === "outcome" ? (
                      inlineInput(d, "Outcome, e.g. Pass - too concentrated")
                    ) : (
                      <button
                        onClick={() => {
                          setEditing({ id: d.id, field: "outcome" });
                          setDraft(d.outcome ?? "");
                        }}
                        className="block min-h-[36px] w-full truncate text-left"
                        title={d.outcome ?? "Add an outcome"}
                      >
                        {d.outcome || <span className="text-[var(--ink-faint)]">-</span>}
                      </button>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {editing?.id === d.id && editing.field === "note" ? (
                      inlineInput(d, "Add a note")
                    ) : (
                      <span className="block truncate text-[var(--ink-soft)]" title={d.last_note ?? ""}>
                        {d.last_note || <span className="text-[var(--ink-faint)]">-</span>}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center justify-between gap-2">
                      {lastInteraction(d, a)}
                      {plusButton(d, "h-9 w-9")}
                    </div>
                  </td>
                  <td className="truncate py-1.5 pr-4 text-[var(--ink-soft)]" title={location(d)}>
                    {location(d) || "-"}
                  </td>
                </tr>
              );
            })}
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

      {/* Phone: one card per deal instead of a sideways-scrolling table. */}
      <ul className="space-y-2 md:hidden" aria-label="Deals">
        {rows.map((d) => {
          const a = attn.get(d.id);
          return (
            <li key={d.id} className={`card px-3.5 py-2 ${a?.closed ? "text-[var(--ink-soft)]" : ""}`}>
              <div className="flex min-w-0 items-center justify-between gap-2">
                <Link
                  href={`/pipeline/${d.id}`}
                  className={`flex min-h-[44px] min-w-0 items-center font-semibold hover:underline ${a?.closed ? "text-[var(--ink-soft)]" : "text-[var(--accent-deep)]"}`}
                >
                  <span className="truncate">{codeLabel(d)}</span>
                </Link>
                <AttentionLabel a={a} />
              </div>
              <PeopleLine deal={d} oneLine prefix={realCompany(d)} />
              <div className="mt-1 flex items-center justify-between gap-2">
                {stageSelect(d, a, "h-11 min-w-0 max-w-[55%]")}
                <div className="flex items-center gap-2 text-sm">
                  {lastInteraction(d, a)}
                  {plusButton(d, "h-11 w-11")}
                </div>
              </div>
              {editing?.id === d.id && <div className="mt-2">{inlineInput(d, editing.field === "note" ? "Add a note" : "Outcome")}</div>}
            </li>
          );
        })}
        {rows.length === 0 && <li className="card px-4 py-6 text-center text-sm text-[var(--ink-soft)]">No deals match that search.</li>}
      </ul>
    </div>
  );
}
