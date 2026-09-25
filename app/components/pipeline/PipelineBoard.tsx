"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import PageHeader from "../crm/PageHeader";
import EmptyState from "../crm/EmptyState";
import DataTable, { type Column } from "../crm/DataTable";
import { Button } from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";
import DealCard from "./DealCard";
import CreateDealForm from "./CreateDealForm";
import { formatDate, isOverdue } from "./dateUtils";
import PipelineForecast from "./PipelineForecast";
import { formatMoney, weightedFee, type StageDefaults } from "../../lib/dealMath";
import type { Deal } from "./types";

type ViewMode = "board" | "list";

export default function PipelineBoard({ stages, isOwner = false, cfg }: { stages: readonly string[]; isOwner?: boolean; cfg: StageDefaults }) {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("board");
  const [mobileStage, setMobileStage] = useState<string>(stages[0]);
  const [creatingInStage, setCreatingInStage] = useState<string | null>(null);
  const [creatingGlobal, setCreatingGlobal] = useState(false);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [boardOverflows, setBoardOverflows] = useState(false);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Deal | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/deals")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setDeals(Array.isArray(data.items) ? data.items : []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load deals.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Tells the honest "scroll sideways" note whether the board is actually
  // wider than the viewport, instead of always showing it or never showing
  // it. No gradient edge fade (refused): a plain sentence is the cue.
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const check = () => setBoardOverflows(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    window.addEventListener("resize", check);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", check);
    };
  }, [deals, stages]);

  const byStage = useMemo(() => {
    const map = new Map<string, Deal[]>();
    for (const s of stages) map.set(s, []);
    for (const d of deals ?? []) {
      if (!map.has(d.stage)) map.set(d.stage, []);
      map.get(d.stage)!.push(d);
    }
    return map;
  }, [deals, stages]);

  async function moveDeal(dealId: number, stage: string) {
    if (!deals) return;
    const prev = deals;
    const target = deals.find((d) => d.id === dealId);
    if (!target || target.stage === stage) return;
    setDeals(deals.map((d) => (d.id === dealId ? { ...d, stage } : d)));
    try {
      const res = await fetch(`/api/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) throw new Error("failed");
      const data = await res.json();
      setDeals((cur) => (cur ? cur.map((d) => (d.id === dealId ? { ...d, ...data.item } : d)) : cur));
    } catch {
      setDeals(prev);
      setError("Could not move that deal. It has been put back.");
      setTimeout(() => setError(null), 4000);
    }
  }

  async function confirmDeleteTarget() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/deals/${deleteTarget.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError(data?.error ?? "Could not delete this deal.");
        return;
      }
      setDeals((cur) => (cur ? cur.filter((d) => d.id !== deleteTarget.id) : cur));
      setDeleteTarget(null);
    } catch {
      setDeleteError("Could not reach the server.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const header = (
    <PageHeader
      title="Pipeline"
      subtitle={`${stages.length} stages, from sourcing through close.`}
      actions={
        <Button
          onClick={() => {
            setCreatingGlobal((v) => !v);
            setCreatingInStage(null);
          }}
        >
          New deal
        </Button>
      }
    />
  );

  if (error && !deals) {
    return (
      <div>
        {header}
        <div className="text-sm text-[var(--bad)]">{error}</div>
      </div>
    );
  }

  if (!deals) {
    return (
      <div>
        {header}
        <div className="text-sm text-[var(--ink-faint)]">Loading pipeline...</div>
      </div>
    );
  }

  if (deals.length === 0 && !creatingGlobal) {
    return (
      <div>
        {header}
        <EmptyState
          title="No deals yet"
          detail="A deal tracks one company through the pipeline, from first contact to close."
          action={
            <Button variant="secondary" onClick={() => setCreatingGlobal(true)}>
              New deal
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div>
      {header}

      {creatingGlobal && (
        <div className="mb-6">
          <CreateDealForm
            defaultStage={stages[0]}
            stages={stages}
            onCreated={(deal) => {
              setDeals((cur) => [deal, ...(cur ?? [])]);
              setCreatingGlobal(false);
            }}
            onCancel={() => setCreatingGlobal(false)}
          />
        </div>
      )}

      <PipelineForecast deals={deals} cfg={cfg} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="card flex p-0.5 text-sm">
          <button
            onClick={() => setView("board")}
            aria-pressed={view === "board"}
            className={`min-h-[38px] rounded-[var(--radius-sm)] px-3 ${view === "board" ? "bg-[var(--paper-deep)] font-medium text-[var(--ink)]" : "text-[var(--ink-soft)]"}`}
          >
            Board
          </button>
          <button
            onClick={() => setView("list")}
            aria-pressed={view === "list"}
            className={`min-h-[38px] rounded-[var(--radius-sm)] px-3 ${view === "list" ? "bg-[var(--paper-deep)] font-medium text-[var(--ink)]" : "text-[var(--ink-soft)]"}`}
          >
            List
          </button>
        </div>
        {view === "board" && (
          <label className="text-sm md:hidden">
            <span className="sr-only">Stage</span>
            <select
              value={mobileStage}
              onChange={(e) => setMobileStage(e.target.value)}
              className="min-h-[44px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2"
            >
              {stages.map((s) => (
                <option key={s} value={s}>
                  {s} ({byStage.get(s)?.length ?? 0})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && <div className="mb-3 text-sm text-[var(--bad)]">{error}</div>}

      {view === "board" ? (
        <>
          {boardOverflows && (
            <p className="mb-2 hidden text-xs text-[var(--ink-faint)] md:block">
              {stages.length} stages, scroll sideways to see {stages[0]} through {stages[stages.length - 1]}.
            </p>
          )}
          {/* Desktop: full horizontal-scroll board. min-h reaches the bottom
              of the viewport so the hairline column dividers run the full
              height and the board reads as a ruled ledger of stages, not
              cards floating above empty paper. Keyboard-focusable so the
              scroll cue above has somewhere to point a focus ring. */}
          <div
            ref={boardRef}
            tabIndex={0}
            className="hidden gap-0 overflow-x-auto pb-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 md:flex md:min-h-[calc(100vh-220px)]"
          >
            {stages.map((stage, i) => (
              <StageColumn
                key={stage}
                stage={stage}
                tintIndex={i}
                deals={byStage.get(stage) ?? []}
                stages={stages}
                onMove={moveDeal}
                creating={creatingInStage === stage}
                onStartCreate={() => setCreatingInStage(stage)}
                onCancelCreate={() => setCreatingInStage(null)}
                onCreated={(deal) => {
                  setDeals((cur) => [deal, ...(cur ?? [])]);
                  setCreatingInStage(null);
                }}
                dragOver={dragOverStage === stage}
                onDragOverStage={setDragOverStage}
              />
            ))}
          </div>
          {/* Mobile: single-column stage selector */}
          <div className="md:hidden">
            <StageColumn
              stage={mobileStage}
              deals={byStage.get(mobileStage) ?? []}
              stages={stages}
              onMove={moveDeal}
              creating={creatingInStage === mobileStage}
              onStartCreate={() => setCreatingInStage(mobileStage)}
              onCancelCreate={() => setCreatingInStage(null)}
              onCreated={(deal) => {
                setDeals((cur) => [deal, ...(cur ?? [])]);
                setCreatingInStage(null);
              }}
              dragOver={dragOverStage === mobileStage}
              onDragOverStage={setDragOverStage}
              hideHeader
            />
          </div>
        </>
      ) : (
        <DealTable
          deals={deals}
          cfg={cfg}
          stages={stages}
          onMove={moveDeal}
          isOwner={isOwner}
          onRequestDelete={(deal) => {
            setDeleteError(null);
            setDeleteTarget(deal);
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          titleId="delete-deal-title"
          title={`Delete the deal "${deleteTarget.title}"?`}
          detail="Its tasks and timeline notes go with it. The audit trail keeps a record."
          confirmLabel="Delete deal"
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteError(null);
          }}
          onConfirm={confirmDeleteTarget}
        />
      )}
    </div>
  );
}

const STAGE_TINTS = ["var(--tint-1)", "var(--tint-2)", "var(--tint-3)", "var(--tint-4)"];

function StageColumn({
  stage,
  tintIndex = 0,
  deals,
  stages,
  onMove,
  creating,
  onStartCreate,
  onCancelCreate,
  onCreated,
  dragOver,
  onDragOverStage,
  hideHeader = false,
}: {
  stage: string;
  tintIndex?: number;
  deals: Deal[];
  stages: readonly string[];
  onMove: (dealId: number, stage: string) => void;
  creating: boolean;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onCreated: (deal: Deal) => void;
  dragOver: boolean;
  onDragOverStage: (stage: string | null) => void;
  hideHeader?: boolean;
}) {
  const tint = STAGE_TINTS[tintIndex % STAGE_TINTS.length];
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        onDragOverStage(stage);
      }}
      onDragLeave={() => onDragOverStage(null)}
      onDrop={(e) => {
        e.preventDefault();
        onDragOverStage(null);
        const id = Number(e.dataTransfer.getData("text/deal-id"));
        if (id) onMove(id, stage);
      }}
      className={`flex w-full flex-shrink-0 flex-col gap-2 rounded-[var(--radius-lg)] px-3 pb-3 mx-1 md:w-64 md:min-h-full ${
        dragOver ? "bg-[var(--paper-deep)]" : "bg-[var(--surface)]/60"
      }`}
    >
      {!hideHeader && (
        <div className="flex items-center justify-between px-1 pt-3">
          <h2 className="text-sm font-semibold text-[var(--ink)]">{stage}</h2>
          <span
            className="numeric inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold text-[var(--ink-soft)]"
            style={{ background: tint }}
          >
            {deals.length}
          </span>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {deals.map((deal) => (
          <DealCard key={deal.id} deal={deal} stages={stages} onMove={onMove} />
        ))}
        {deals.length === 0 && !creating && (
          <div className="rounded-[12px] bg-[var(--paper)] p-3 text-center text-xs text-[var(--ink-faint)]">
            No deals in {stage}
          </div>
        )}
        {creating ? (
          <CreateDealForm defaultStage={stage} onCreated={onCreated} onCancel={onCancelCreate} />
        ) : (
          <Button variant="secondary" size="sm" onClick={onStartCreate}>
            + Add deal
          </Button>
        )}
      </div>
    </div>
  );
}

function DealTable({
  deals,
  cfg,
  stages,
  onMove,
  isOwner,
  onRequestDelete,
}: {
  deals: Deal[];
  cfg: StageDefaults;
  stages: readonly string[];
  onMove: (dealId: number, stage: string) => void;
  isOwner: boolean;
  onRequestDelete: (deal: Deal) => void;
}) {
  const columns: Column<Deal>[] = [
    { key: "title", label: "Deal", render: (d) => d.title },
    { key: "company", label: "Company", render: (d) => <span className="text-[var(--ink-soft)]">{d.company_name}</span> },
    {
      key: "stage",
      label: "Stage",
      render: (d) => (
        <label onClick={(e) => e.stopPropagation()}>
          <span className="sr-only">Move {d.title}</span>
          <select
            value={d.stage}
            onChange={(e) => onMove(d.id, e.target.value)}
            className="min-h-[36px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--paper)] px-2 text-xs"
          >
            {stages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      ),
    },
    { key: "ev", label: "EV", render: (d) => <span className="numeric text-[var(--ink-soft)]">{formatMoney(d.enterprise_value) || "-"}</span> },
    {
      key: "weighted",
      label: "Weighted fee",
      render: (d) => <span className="numeric text-[var(--ink-soft)]">{formatMoney(weightedFee(d, cfg)) || "-"}</span>,
    },
    { key: "next_step", label: "Next step", render: (d) => <span className="text-[var(--ink-soft)]">{d.next_step ?? "-"}</span> },
    {
      key: "due",
      label: "Due",
      render: (d) => (
        <span className={isOverdue(d.next_step_due) ? "font-medium text-[var(--bad)]" : "text-[var(--ink-soft)]"}>
          {d.next_step_due ? (isOverdue(d.next_step_due) ? "overdue " : "") + formatDate(d.next_step_due) : "-"}
        </span>
      ),
    },
  ];

  if (isOwner) {
    columns.push({
      key: "actions",
      label: "",
      render: (d) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Button variant="danger" size="sm" onClick={() => onRequestDelete(d)}>
            Delete
          </Button>
        </div>
      ),
    });
  }

  return <DataTable columns={columns} rows={deals} rowHref={(d) => `/pipeline/${d.id}`} />;
}
