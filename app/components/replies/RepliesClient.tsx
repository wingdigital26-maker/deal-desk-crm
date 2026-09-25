"use client";
// The "Check for replies" trigger, the Needs a reply / All filter, and the
// mark-handled action. Kept as one client component so the initial read
// still happens server-side (no fetch-on-mount) and only the mutations are
// client code.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import StatusLabel, { type StatusKind } from "../ui/StatusLabel";
import DataTable, { type Column } from "../crm/DataTable";
import EmptyState from "../crm/EmptyState";

export type ReplyRow = {
  id: number;
  fromEmail: string;
  fromName: string | null;
  companyName: string | null;
  subject: string | null;
  firstLine: string | null;
  kind: "reply" | "bounce" | "unsubscribe" | "auto-reply";
  handled: boolean;
  receivedAt: string;
  contactId: number | null;
};

const KIND_LABEL: Record<ReplyRow["kind"], { kind: StatusKind; text: string }> = {
  reply: { kind: "ok", text: "Replied" },
  bounce: { kind: "warn", text: "Bounced" },
  unsubscribe: { kind: "stop", text: "Asked to stop" },
  "auto-reply": { kind: "none", text: "Auto reply" },
};

type Filter = "needs" | "all";

// Human date+time, never a locale dump: "Sep 19, 5:00 PM".
function formatReceived(iso: string): string {
  const d = new Date(iso.includes("T") || iso.endsWith("Z") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  const datePart = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const timePart = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
}

export default function RepliesClient({
  replies,
  apolloConfigured,
  instantlyConfigured = false,
  canCheckInstantly = false,
}: {
  replies: ReplyRow[];
  apolloConfigured: boolean;
  instantlyConfigured?: boolean;
  canCheckInstantly?: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("needs");
  const [busy, setBusy] = useState(false);
  const [markingId, setMarkingId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () => (filter === "needs" ? replies.filter((r) => r.kind === "reply" && !r.handled) : replies),
    [replies, filter]
  );

  async function checkForReplies() {
    if (!apolloConfigured) {
      setError(null);
      setMessage("Not connected yet. Replies appear here once the firm's sending account is connected.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/replies/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not check for replies");
      setMessage(
        data.inserted > 0
          ? `Found ${data.inserted} new message${data.inserted === 1 ? "" : "s"} out of ${data.fetched} checked.`
          : `Nothing new. ${data.fetched} message${data.fetched === 1 ? "" : "s"} checked.`
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check for replies");
    } finally {
      setBusy(false);
    }
  }

  async function checkInstantly() {
    if (!instantlyConfigured) {
      setError(null);
      setMessage("Instantly is not connected yet. Add INSTANTLY_API_KEY to the workspace settings, then check again.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/replies/instantly", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not check Instantly for replies");
      const parts = [`${data.fetched} message${data.fetched === 1 ? "" : "s"} checked`];
      if (data.inserted > 0) parts.push(`${data.inserted} new`);
      if (data.autoReplies > 0) parts.push(`${data.autoReplies} auto repl${data.autoReplies === 1 ? "y" : "ies"}`);
      if (data.dealsOpened > 0) parts.push(`${data.dealsOpened} deal${data.dealsOpened === 1 ? "" : "s"} opened`);
      setMessage(data.inserted > 0 ? `${parts.join(", ")}.` : `Nothing new from Instantly. ${parts[0]}.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check Instantly for replies");
    } finally {
      setBusy(false);
    }
  }

  async function markHandled(id: number) {
    setMarkingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/replies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handled: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not mark this reply handled");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark this reply handled");
    } finally {
      setMarkingId(null);
    }
  }

  const columns: Column<ReplyRow>[] = [
    {
      key: "from",
      label: "From",
      render: (r) => (
        <div>
          <div className="font-medium text-[var(--ink)]">{r.fromName || r.fromEmail}</div>
          {r.fromName && <div className="text-xs text-[var(--ink-faint)]">{r.fromEmail}</div>}
        </div>
      ),
    },
    {
      key: "company",
      label: "Company",
      priority: 3,
      className: "max-w-[140px]",
      render: (r) =>
        r.companyName ? (
          <span className="block truncate" title={r.companyName}>
            {r.companyName}
          </span>
        ) : (
          <span className="text-[var(--ink-faint)]">-</span>
        ),
    },
    { key: "subject", label: "Subject", render: (r) => r.subject || <span className="text-[var(--ink-faint)]">-</span>, flex: true, widthPct: 30, priority: 2 },
    { key: "firstLine", label: "First line", render: (r) => r.firstLine || <span className="text-[var(--ink-faint)]">-</span>, flex: true, className: "text-[var(--ink-soft)]", priority: 2 },
    {
      key: "kind",
      label: "Type",
      render: (r) => (
        <StatusLabel kind={KIND_LABEL[r.kind].kind}>{KIND_LABEL[r.kind].text}</StatusLabel>
      ),
    },
    {
      key: "received",
      label: "Received",
      className: "numeric text-right",
      render: (r) => <span className="numeric">{formatReceived(r.receivedAt)}</span>,
      priority: 2,
    },
    {
      key: "actions",
      label: "",
      render: (r) =>
        r.handled ? (
          <span className="text-xs text-[var(--ink-faint)]">Handled</span>
        ) : (
          <Button variant="quiet" size="sm" disabled={markingId === r.id} onClick={() => markHandled(r.id)}>
            Mark handled
          </Button>
        ),
    },
  ];

  const rowsWithHref = replies.length > 0 ? visible : [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="card inline-flex p-0.5 text-sm">
          <button
            onClick={() => setFilter("needs")}
            className={`min-h-[40px] rounded-[calc(var(--radius-sm)-2px)] px-3 py-1.5 font-medium ${
              filter === "needs" ? "bg-[var(--paper-deep)] text-[var(--ink)]" : "text-[var(--ink-soft)]"
            }`}
          >
            Needs a reply
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`min-h-[40px] rounded-[calc(var(--radius-sm)-2px)] px-3 py-1.5 font-medium ${
              filter === "all" ? "bg-[var(--paper-deep)] text-[var(--ink)]" : "text-[var(--ink-soft)]"
            }`}
          >
            All
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {canCheckInstantly && (
            <Button variant="primary" onClick={checkInstantly} disabled={busy}>
              {busy ? "Checking..." : "Check Instantly for replies"}
            </Button>
          )}
          <Button variant={canCheckInstantly ? "secondary" : "primary"} onClick={checkForReplies} disabled={busy}>
            {busy ? "Checking..." : "Check for replies"}
          </Button>
        </div>
      </div>

      {message && <p className="mb-3 text-sm text-[var(--ink-soft)]">{message}</p>}
      {error && <p className="mb-3 text-sm text-[var(--bad)]">{error}</p>}

      {replies.length === 0 ? (
        <EmptyState
          title="No replies yet."
          detail="Replies appear here after the firm's sending account is connected."
        />
      ) : visible.length === 0 ? (
        <EmptyState title="Nothing needs a reply right now." detail="Switch to All to see every message, including bounces and auto-replies." />
      ) : (
        <DataTable columns={columns} rows={rowsWithHref} rowHref={(r) => (r.contactId ? `/contacts/${r.contactId}` : "")} />
      )}
    </div>
  );
}
