"use client";
// Browse outbound messages by status, open one for the exact rendered email.
// Takes its first page of data as props from the server component so there is
// no fetch-on-mount effect; switching the status tab fetches directly inside
// the click handler.
import { useState } from "react";
import PageHeader from "../crm/PageHeader";
import { Button, ButtonLink } from "../ui/Button";
import DataTable, { type Column } from "../crm/DataTable";
import EmptyState from "../crm/EmptyState";
import { Card, queueStatusLabel } from "./ui";
import StatusLabel from "../ui/StatusLabel";

export type Message = {
  id: number;
  status: "queued" | "held" | "sent" | "failed" | "cancelled";
  mailbox: string | null;
  scheduled_for: string | null;
  sent_at: string | null;
  error: string | null;
  provider_id?: string | null;
  rendered_subject: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

const STATUSES = ["all", "queued", "held", "sent", "failed", "cancelled"] as const;

// Human date, never the raw ISO string: "Sep 25" for this year, "Sep 25, 2026"
// once it is not.
function formatScheduled(iso: string | null): string {
  if (!iso) return "Not set";
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "Not set";
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date().getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString("en-US", opts);
}

export default function QueueClient({
  initialMessages,
  initialCounts,
  children,
}: {
  initialMessages: Message[];
  initialCounts: Record<string, number>;
  /** The "Send what is due" control, rendered directly under the page h1,
   * above the status tabs, as a child so the server-rendered control crosses
   * the client boundary the standard "slot" way. */
  children?: React.ReactNode;
}) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [counts, setCounts] = useState<Record<string, number>>(initialCounts);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadStatus(next: (typeof STATUSES)[number]) {
    setStatus(next);
    setLoading(true);
    try {
      const url = next === "all" ? "/api/outbound/messages" : `/api/outbound/messages?status=${next}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load messages.");
      setMessages(data.messages);
      setCounts(Object.fromEntries(data.counts.map((c: { status: string; n: number }) => [c.status, c.n])));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load messages.");
    } finally {
      setLoading(false);
    }
  }

  async function cancel(id: number) {
    try {
      const res = await fetch(`/api/outbound/messages/${id}/cancel`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not cancel.");
      }
      await loadStatus(status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel.");
    }
  }

  const columns: Column<Message>[] = [
    { key: "subject", label: "Subject", flex: true, render: (m) => m.rendered_subject },
    {
      key: "contact",
      label: "Contact",
      className: "text-[var(--ink-soft)]",
      truncate: true,
      render: (m) => `${m.first_name} ${m.last_name} <${m.email}>`,
    },
    { key: "mailbox", label: "Mailbox", render: (m) => m.mailbox ?? "Not set" },
    {
      key: "scheduled",
      label: "Scheduled",
      className: "numeric text-right",
      render: (m) => <span className="numeric">{formatScheduled(m.scheduled_for)}</span>,
    },
    {
      key: "status",
      label: "Status",
      render: (m) => {
        const s = queueStatusLabel(m.status, m.provider_id);
        return <StatusLabel kind={s.kind}>{s.text}</StatusLabel>;
      },
    },
    {
      key: "actions",
      label: "",
      render: (m) =>
        m.status === "queued" || m.status === "held" ? (
          <Button variant="secondary" size="sm" onClick={() => cancel(m.id)}>
            Cancel
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader title="Queue" subtitle="Every message this desk has rendered, by status." />

      {children}

      <div className="mb-4 flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => loadStatus(s)}
            className={`inline-flex min-h-[44px] items-center rounded-full border px-4 text-[13px] capitalize ${
              status === s
                ? "border-[var(--rule-strong)] bg-[var(--paper-deep)] text-[var(--ink)]"
                : "border-[var(--rule)] bg-[var(--surface)] text-[var(--ink-soft)] hover:bg-[var(--paper)]"
            }`}
          >
            {s} {s !== "all" && counts[s] ? `(${counts[s]})` : ""}
          </button>
        ))}
      </div>

      {error && (
        <Card className="mb-4 border border-[color-mix(in_srgb,var(--bad)_35%,transparent)] px-4 py-2">
          <p className="text-sm text-[var(--bad)]">{error}</p>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-[var(--ink-soft)]">Loading.</p>
      ) : messages.length === 0 ? (
        <EmptyState
          title="No messages here"
          detail="Queue contacts against an approved template to see them appear."
          action={<ButtonLink href="/outbound/templates">Go to templates</ButtonLink>}
        />
      ) : (
        <DataTable columns={columns} rows={messages} rowHref={(m) => `/outbound/queue/${m.id}`} />
      )}
    </div>
  );
}
