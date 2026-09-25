// Shared display primitives for the outbound lane that the CRM-wide primitives
// (Button, PageHeader, DataTable, EmptyState, Field, StatusLabel) do not
// cover: a bordered card and small status-label mapping helpers. Tokens from
// app/globals.css only. Status is always StatusLabel (icon plus text), never
// a coloured pill background.
import type { StatusKind } from "../ui/StatusLabel";

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

// Outbound message status -> StatusLabel kind and plain-English text.
// A "sent" message whose provider id starts with "dryrun_" was never
// actually delivered (DryRunProvider is the default everywhere here).
export function queueStatusLabel(
  status: "queued" | "held" | "sent" | "failed" | "cancelled",
  providerId?: string | null
): { kind: StatusKind; text: string } {
  switch (status) {
    case "queued":
      return { kind: "none", text: "Queued" };
    case "held":
      return { kind: "warn", text: "Held" };
    case "sent":
      return providerId && providerId.startsWith("dryrun_")
        ? { kind: "ok", text: "Checked only, nothing left" }
        : { kind: "ok", text: "Sent" };
    case "failed":
      return { kind: "stop", text: "Failed" };
    case "cancelled":
      return { kind: "stop", text: "Cancelled" };
  }
}

export function rampStatusLabel(meetsTarget: boolean): { kind: StatusKind; text: string } {
  return meetsTarget ? { kind: "ok", text: "Meets the goal" } : { kind: "none", text: "Below the goal" };
}

export function mailboxStatusLabel(paused: boolean, warmupStarted: string | null): { kind: StatusKind; text: string } {
  if (paused) return { kind: "warn", text: "Paused" };
  if (warmupStarted) return { kind: "ok", text: "Warming" };
  return { kind: "none", text: "Not started" };
}

export const inputClass =
  "min-h-[44px] w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)] outline-none focus-visible:border-[var(--accent)]";

// Turns the internal, engineering-flavored block/hold reasons that come out
// of app/lib/outbound/sendGate.ts and app/lib/compliance into sentences a
// banker understands, without editing that (shared, out-of-lane) code.
const REASON_REWRITES: [RegExp, string][] = [
  [/OUTBOUND_SEND_ENABLED is not set to "1"\.?/gi, "Sending is switched off for this workspace."],
  [/\bcontent hash\b/gi, "approval reference"],
  [/\bhash\b/gi, "approval reference"],
  [/\bno MX record\b/gi, "failed the email domain check"],
  [/\benv(ironment)? var(iable)?s?\b/gi, "workspace setting"],
  [/\bdry[- ]?run\b/gi, "checked only, nothing sent"],
];

export function translateReason(reason: string): string {
  let out = reason;
  for (const [pattern, replacement] of REASON_REWRITES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function translateReasons(reasons: string[]): string[] {
  return reasons.map(translateReason);
}
