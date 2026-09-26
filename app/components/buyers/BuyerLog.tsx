"use client";
// Buyer log for one mandate: funnel strip, the buyer table (cards on a phone
// with Back / Advance), bulk add and bulk stage change, the IOI/LOI terms grid
// and the stage history. Every change goes through /api/deal-buyers, which
// writes the append-only history and the audit row.
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import Panel from "../ui/Panel";
import { Button, ButtonLink } from "../ui/Button";
import EmptyState from "../crm/EmptyState";
import { inputClass } from "../crm/Field";
import BuyerAdd from "./BuyerAdd";
import TermsGrid from "./TermsGrid";
import { ioiText, stageText } from "./format";
import {
  BUYER_STAGES,
  BUYER_STAGE_LABELS,
  BUYER_TYPE_LABELS,
  FORWARD_STAGES,
  hasTerms,
  isBuyerStage,
  nextStage,
  prevStage,
  type BuyerStage,
  type BuyerType,
} from "../../lib/buyerStages";
import type { BuyerRow } from "../../lib/buyers";

type Data = { items: BuyerRow[]; funnel: Record<BuyerStage, number>; reached: Record<string, number> };
type View = "buyers" | "terms";

const selectClass =
  "h-[44px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]";

function lastMove(b: BuyerRow): string | null {
  const stamps = BUYER_STAGES.map((s) => b[`${s}_at`]).filter(Boolean) as string[];
  return stamps.sort().at(-1) ?? null;
}

const shortDate = (s: string | null) =>
  s ? new Date(s.replace(" ", "T") + (s.includes("T") ? "" : "Z")).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

export default function BuyerLog({ dealId, initial }: { dealId: number; initial: Data }) {
  const [data, setData] = useState<Data>(initial);
  const [view, setView] = useState<View>("buyers");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [stageFilter, setStageFilter] = useState<string>("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [decline, setDecline] = useState<{ ids: number[] } | null>(null);
  const [bulkStage, setBulkStage] = useState<string>("");

  const reload = useCallback(async () => {
    const res = await fetch(`/api/deal-buyers?deal_id=${dealId}`).catch(() => null);
    if (res?.ok) setData(await res.json());
  }, [dealId]);

  async function send(url: string, method: string, body: unknown): Promise<boolean> {
    setError(null);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!res) {
      setError("Could not reach the server.");
      return false;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d?.error ?? "That change was not saved.");
      return false;
    }
    await reload();
    return true;
  }

  function moveTo(ids: number[], stage: BuyerStage) {
    if (stage === "declined") {
      setDecline({ ids });
      return;
    }
    if (ids.length === 1) return send(`/api/deal-buyers/${ids[0]}`, "PATCH", { stage });
    return send("/api/deal-buyers/bulk-stage", "POST", { ids, stage }).then((ok) => ok && setSelected(new Set()));
  }

  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    return data.items.filter((b) => (!stageFilter || b.stage === stageFilter) && (!q || b.buyer_name.toLowerCase().includes(q)));
  }, [data.items, stageFilter, text]);

  const allSelected = rows.length > 0 && rows.every((b) => selected.has(b.id));
  const toggle = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const total = data.items.length;
  const termsCount = data.items.filter(hasTerms).length;

  return (
    <Panel
      title={
        <span>
          Buyer log <span className="text-[13px] font-medium text-[var(--ink-soft)]">{total} {total === 1 ? "buyer" : "buyers"}</span>
        </span>
      }
      actions={
        <>
          <ButtonLink href={`/pipeline/${dealId}/report`} variant="secondary" size="sm">
            Seller report
          </ButtonLink>
          <Button size="sm" onClick={() => setAdding((a) => !a)}>
            {adding ? "Close" : "Add buyers"}
          </Button>
        </>
      }
    >
      <FunnelStrip reached={data.reached} funnel={data.funnel} onPick={(s) => setStageFilter((cur) => (cur === s ? "" : s))} active={stageFilter} />

      {adding && (
        <div className="mt-4">
          <BuyerAdd
            dealId={dealId}
            onAdded={async (msg) => {
              setNotice(msg);
              await reload();
            }}
          />
        </div>
      )}

      {notice && <div className="mt-3 text-sm text-[var(--ink-soft)]">{notice}</div>}
      {error && <div className="mt-3 text-sm text-[var(--bad)]">{error}</div>}

      {total === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="No buyers on this mandate yet"
            detail="Add PE firms, strategics and family offices from your companies, from buyers you showed earlier deals, or paste a CSV."
            action={!adding ? <Button variant="secondary" onClick={() => setAdding(true)}>Add buyers</Button> : undefined}
          />
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="card flex p-0.5 text-sm">
              {(["buyers", "terms"] as View[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={`min-h-[40px] rounded-[var(--radius-sm)] px-3 ${view === v ? "bg-[var(--paper-deep)] font-medium text-[var(--ink)]" : "text-[var(--ink-soft)]"}`}
                >
                  {v === "buyers" ? "Buyers" : `Terms grid (${termsCount})`}
                </button>
              ))}
            </div>
            {view === "buyers" && (
              <>
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Filter by buyer name"
                  aria-label="Filter by buyer name"
                  className={`${inputClass} max-w-[240px]`}
                />
                <select aria-label="Filter by stage" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className={selectClass}>
                  <option value="">All stages</option>
                  {BUYER_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {BUYER_STAGE_LABELS[s]} ({data.funnel[s]})
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          {view === "terms" ? (
            <div className="mt-4">
              <TermsGrid buyers={data.items.filter(hasTerms)} onSave={(id, patch) => send(`/api/deal-buyers/${id}`, "PATCH", patch)} />
            </div>
          ) : (
            <>
              {selected.size > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[12px] bg-[var(--paper)] px-3 py-2 text-sm">
                  <span className="font-semibold text-[var(--ink)]">{selected.size} selected</span>
                  <select aria-label="Move selected to stage" value={bulkStage} onChange={(e) => setBulkStage(e.target.value)} className={selectClass}>
                    <option value="">Move to stage</option>
                    {BUYER_STAGES.map((s) => (
                      <option key={s} value={s}>
                        {BUYER_STAGE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={!bulkStage}
                    onClick={async () => {
                      await moveTo([...selected], bulkStage as BuyerStage);
                      setBulkStage("");
                    }}
                  >
                    Apply to {selected.size}
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                </div>
              )}

              {/* Desktop table */}
              <div className="mt-3 hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--rule)] text-left text-[12px] font-semibold text-[var(--ink-soft)]">
                      <th className="w-8 py-2 pr-2">
                        <input
                          type="checkbox"
                          aria-label="Select all shown buyers"
                          checked={allSelected}
                          onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((b) => b.id)))}
                        />
                      </th>
                      <th className="py-2 pr-3">Buyer</th>
                      <th className="py-2 pr-3">Lead contact</th>
                      <th className="py-2 pr-3">Stage</th>
                      <th className="py-2 pr-3">Last move</th>
                      <th className="py-2 pr-3">IOI</th>
                      <th className="py-2 pr-3">Note</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b) => (
                      <tr key={b.id} className="border-b border-[var(--rule)] align-middle last:border-0">
                        <td className="py-2 pr-2">
                          <input type="checkbox" aria-label={`Select ${b.buyer_name}`} checked={selected.has(b.id)} onChange={() => toggle(b.id)} />
                        </td>
                        <td className="py-2 pr-3">
                          <Link href={`/companies/${b.buyer_company_id}`} className="font-semibold text-[var(--ink)] hover:underline">
                            {b.buyer_name}
                          </Link>
                          {b.buyer_type && <div className="text-[12px] text-[var(--ink-soft)]">{BUYER_TYPE_LABELS[b.buyer_type as BuyerType] ?? b.buyer_type}</div>}
                        </td>
                        <td className="py-2 pr-3 text-[var(--ink-soft)]">
                          {b.lead_contact_id ? (
                            <Link href={`/contacts/${b.lead_contact_id}`} className="hover:underline">
                              {[b.lead_first_name, b.lead_last_name].filter(Boolean).join(" ")}
                            </Link>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          <select aria-label={`Stage for ${b.buyer_name}`} value={b.stage} onChange={(e) => moveTo([b.id], e.target.value as BuyerStage)} className={selectClass}>
                            {BUYER_STAGES.map((s) => (
                              <option key={s} value={s}>
                                {BUYER_STAGE_LABELS[s]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="numeric py-2 pr-3 text-[var(--ink-soft)]">{shortDate(lastMove(b))}</td>
                        <td className="numeric py-2 pr-3 text-[var(--ink)]">{hasTerms(b) ? ioiText(b) || "-" : ""}</td>
                        <td className="max-w-[220px] py-2 pr-3 text-[12px] text-[var(--ink-soft)]">
                          {b.stage === "declined" ? (
                            <span title={b.decline_reason ?? ""}>
                              {stageText(b)}: {b.decline_reason}
                            </span>
                          ) : (
                            <span className="line-clamp-2">{b.notes}</span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <Button
                            size="sm"
                            variant="quiet"
                            aria-label={`Remove ${b.buyer_name} from this buyer log`}
                            onClick={() => send(`/api/deal-buyers/${b.id}`, "DELETE", {})}
                          >
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Phone: one card per buyer, one-thumb Back / Advance */}
              <ul className="mt-3 space-y-2 md:hidden">
                {rows.map((b) => {
                  const next = nextStage(b.stage);
                  const prev = prevStage(b.stage);
                  return (
                    <li key={b.id} className="rounded-[14px] bg-[var(--paper)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Link href={`/companies/${b.buyer_company_id}`} className="block truncate font-semibold text-[var(--ink)]">
                            {b.buyer_name}
                          </Link>
                          <div className="text-[12px] text-[var(--ink-soft)]">
                            {stageText(b)}
                            {hasTerms(b) && ioiText(b) ? ` · ${ioiText(b)}` : ""}
                          </div>
                        </div>
                        <input type="checkbox" aria-label={`Select ${b.buyer_name}`} checked={selected.has(b.id)} onChange={() => toggle(b.id)} className="mt-1 h-5 w-5" />
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        <Button size="sm" variant="secondary" disabled={!prev} onClick={() => prev && moveTo([b.id], prev)}>
                          Back
                        </Button>
                        {b.stage === "declined" && isBuyerStage(b.declined_from_stage) ? (
                          <Button size="sm" variant="secondary" onClick={() => moveTo([b.id], b.declined_from_stage as BuyerStage)}>
                            Reopen
                          </Button>
                        ) : (
                          <Button size="sm" disabled={!next} onClick={() => next && moveTo([b.id], next)}>
                            {next ? BUYER_STAGE_LABELS[next] : "Done"}
                          </Button>
                        )}
                        <Button size="sm" variant="danger" disabled={b.stage === "declined"} onClick={() => moveTo([b.id], "declined")}>
                          Decline
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {rows.length === 0 && <p className="mt-3 text-sm text-[var(--ink-soft)]">No buyers match that filter.</p>}
            </>
          )}
        </>
      )}

      {decline && (
        <DeclineDialog
          count={decline.ids.length}
          onCancel={() => setDecline(null)}
          onConfirm={async (reason) => {
            const ok =
              decline.ids.length === 1
                ? await send(`/api/deal-buyers/${decline.ids[0]}`, "PATCH", { stage: "declined", decline_reason: reason })
                : await send("/api/deal-buyers/bulk-stage", "POST", { ids: decline.ids, stage: "declined", decline_reason: reason });
            if (ok) {
              setDecline(null);
              setSelected(new Set());
            }
          }}
        />
      )}
    </Panel>
  );
}

function FunnelStrip({
  reached,
  funnel,
  onPick,
  active,
}: {
  reached: Record<string, number>;
  funnel: Record<BuyerStage, number>;
  onPick: (s: BuyerStage) => void;
  active: string;
}) {
  const tiles: { stage: BuyerStage; big: number; small: string }[] = [
    ...FORWARD_STAGES.map((s) => ({ stage: s, big: reached[s] ?? 0, small: `${funnel[s]} here now` })),
    { stage: "declined" as BuyerStage, big: funnel.declined, small: "dropped out" },
  ];
  return (
    <ol className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-5 sm:overflow-visible sm:px-0 xl:grid-cols-10" aria-label="Buyer funnel: how many buyers reached each stage">
      {tiles.map((t) => (
        <li key={t.stage} className="w-[104px] shrink-0 sm:w-auto">
          <button
            onClick={() => onPick(t.stage)}
            aria-pressed={active === t.stage}
            className={`flex min-h-[72px] w-full flex-col justify-between rounded-[12px] px-3 py-2 text-left ${
              active === t.stage ? "bg-[var(--navy)] text-white" : "bg-[var(--paper)] text-[var(--ink)]"
            }`}
          >
            <span className={`text-[11px] font-semibold ${active === t.stage ? "text-white/80" : "text-[var(--ink-soft)]"}`}>{BUYER_STAGE_LABELS[t.stage]}</span>
            <span className="numeric text-[22px] font-bold leading-none">{t.big}</span>
            <span className={`text-[10px] ${active === t.stage ? "text-white/70" : "text-[var(--ink-faint)]"}`}>{t.small}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function DeclineDialog({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const presets = ["Valuation gap", "Outside thesis", "Too small", "Timing", "Financing", "Went quiet"];
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="decline-title" className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
      <div className="card w-full max-w-md p-5">
        <h2 id="decline-title" className="text-[16px] font-bold text-[var(--ink)]">
          Why {count === 1 ? "did this buyer" : `did these ${count} buyers`} decline?
        </h2>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">The reason is kept with the buyer and shows on its company page next time.</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button key={p} onClick={() => setReason(p)} className="min-h-[36px] rounded-full bg-[var(--paper)] px-3 text-[13px] text-[var(--ink)] hover:bg-[var(--paper-deep)]">
              {p}
            </button>
          ))}
        </div>
        <label htmlFor="decline-reason" className="sr-only">
          Decline reason
        </label>
        <input id="decline-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} mt-3`} placeholder="Reason" />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!reason.trim() || busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm(reason.trim());
              setBusy(false);
            }}
          >
            Mark declined
          </Button>
        </div>
      </div>
    </div>
  );
}
