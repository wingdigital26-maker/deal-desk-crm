"use client";
import Link from "next/link";
import StatusLabel from "../ui/StatusLabel";
import { ChevronDownIcon } from "../ui/icons";
import { formatDate, isOverdue } from "./dateUtils";
import type { Deal } from "./types";

export default function DealCard({
  deal,
  stages,
  onMove,
  draggable = true,
}: {
  deal: Deal;
  stages: readonly string[];
  onMove: (dealId: number, stage: string) => void;
  draggable?: boolean;
}) {
  const overdue = isOverdue(deal.next_step_due);

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/deal-id", String(deal.id));
        e.dataTransfer.effectAllowed = "move";
      }}
      className="card lift cursor-grab p-3.5 active:cursor-grabbing"
    >
      <Link href={`/pipeline/${deal.id}`} className="block">
        <div className="line-clamp-2 truncate text-sm font-bold text-[var(--ink)] hover:underline">{deal.company_name}</div>
        <div className="mt-0.5 line-clamp-2 text-xs text-[var(--ink-soft)]">{deal.title}</div>
      </Link>
      {deal.next_step ? (
        <div className="mt-2 truncate text-xs text-[var(--ink-soft)]">{deal.next_step}</div>
      ) : (
        <div className="mt-2 text-xs italic text-[var(--ink-faint)]">No next step set</div>
      )}

      <div className="mt-3 flex flex-nowrap items-center justify-between gap-2">
        <label className="relative inline-flex h-7 min-w-0 shrink items-center gap-1 text-[13px] text-[var(--ink-soft)]">
          <span className="pointer-events-none inline-flex min-w-0 items-center gap-1">
            <span className="truncate">Move</span>
            <ChevronDownIcon className="shrink-0" />
          </span>
          <span className="sr-only">Move {deal.title} to a different stage</span>
          <select
            aria-label={`Move ${deal.title} to a different stage`}
            value={deal.stage}
            onChange={(e) => onMove(deal.id, e.target.value)}
            className="absolute inset-x-0 top-0 h-11 w-full cursor-pointer opacity-0 md:h-7"
          >
            {stages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {deal.next_step_due ? (
          overdue ? (
            <StatusLabel className="shrink-0 whitespace-nowrap" kind="warn">{`Overdue · ${formatDate(deal.next_step_due)}`}</StatusLabel>
          ) : (
            <span className="numeric shrink-0 whitespace-nowrap text-[var(--ink-faint)]">{formatDate(deal.next_step_due)}</span>
          )
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
