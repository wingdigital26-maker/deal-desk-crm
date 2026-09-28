// Buyer follow-ups: the banker's next step with one buyer on one mandate
// (deal_buyers.next_step / next_step_due). Pure and client-safe: no database,
// no clock unless the caller leaves `today` out. Overdue and due-today use the
// same rules and labels as a deal's next step (app/lib/attention.ts), so a
// buyer follow-up looks exactly like every other thing that is late.
//
// Internal only: follow-ups never appear on the seller report or its export.
import { attention, type Attention } from "./attention";

/** Buyers in these stages are out of the process; their follow-ups stop counting. */
export const FOLLOW_UP_DONE_STAGES = ["closed", "declined"] as const;

/** One-tap follow-up presets on the buyer log. */
export const FOLLOW_UP_PRESETS = [
  { days: 3, label: "In 3 days" },
  { days: 7, label: "In 1 week" },
] as const;

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Calendar date `days` after `today` (both "YYYY-MM-DD"). */
export function addCalendarDays(today: string, days: number): string {
  const [y, m, d] = today.slice(0, 10).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export type FollowUpBuyer = { stage: string; next_step_due?: string | null };

/** The one label for a buyer follow-up: overdue or due today, else null. Never "quiet". */
export function followUpAttention(b: FollowUpBuyer, today: string = localToday()): Pick<Attention, "label" | "overdueDays" | "dueToday"> {
  const a = attention({ stage: b.stage, next_step_due: b.next_step_due }, FOLLOW_UP_DONE_STAGES, today);
  return { label: a.label, overdueDays: a.overdueDays, dueToday: a.dueToday };
}

/** True when the buyer is still in play and the follow-up is due today or earlier. */
export function isFollowUpDue(b: FollowUpBuyer, today: string = localToday()): boolean {
  if ((FOLLOW_UP_DONE_STAGES as readonly string[]).includes(b.stage)) return false;
  return !!b.next_step_due && /^\d{4}-\d{2}-\d{2}/.test(b.next_step_due) && b.next_step_due.slice(0, 10) <= today;
}

/** "Buyer: Red Oak Capital on Project Falcon" (the deal title, else the seller's name). */
export function followUpTitle(buyerName: string, dealTitle: string | null | undefined, companyName: string | null | undefined): string {
  const on = dealTitle?.trim() || companyName?.trim();
  return on ? `Buyer: ${buyerName} on ${on}` : `Buyer: ${buyerName}`;
}

/**
 * Picks which due items a short list shows: up to `reserved` buyer follow-ups
 * are always kept (so buyers are not buried under a pile of old tasks), the
 * rest of the `limit` fills by due date, and the result stays in date order.
 */
export function pickDueItems<T extends { kind: string; due: string }>(items: T[], limit: number, reserved: number): T[] {
  const sorted = [...items].sort((a, b) => a.due.localeCompare(b.due));
  const keep = new Set(sorted.filter((x) => x.kind === "buyer").slice(0, Math.min(reserved, limit)));
  for (const x of sorted) {
    if (keep.size >= limit) break;
    keep.add(x);
  }
  return sorted.filter((x) => keep.has(x));
}
