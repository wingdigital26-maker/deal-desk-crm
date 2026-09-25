"use client";
// Owner-only "Send what is due" control: a deliberate two-step (review, then
// confirm) so nobody fires a real send by accident. Non-owners see who can
// run it instead of the control. Never auto-runs: every fetch here happens
// inside a click handler, never in an effect, and there is no polling.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card, translateReason } from "./ui";
import StatusLabel from "../ui/StatusLabel";

type DueSummary = {
  sendEnabled: boolean;
  totalDue: number;
  unassignedDue: number;
  byMailbox: { mailbox: string; due: number; remainingToday: number }[];
};

type RunResult = { messageId: number; status: "sent" | "held" | "failed"; detail?: string };

export default function SendDueControl({
  isOwner,
  sendEnabled,
  initialTotalDue,
}: {
  isOwner: boolean;
  sendEnabled: boolean;
  initialTotalDue: number;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "review" | "done">("idle");
  const [summary, setSummary] = useState<DueSummary | null>(null);
  const [results, setResults] = useState<RunResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openReview() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/outbound/messages/due");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load what is due.");
      setSummary(data);
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load what is due.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmSend() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/outbound/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not run sending.");
      setResults(data.results ?? []);
      setStep("done");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run sending.");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setStep("idle");
    setSummary(null);
    setResults(null);
    setError(null);
  }

  if (!isOwner) {
    return (
      <Card className="mb-6 px-4 py-3">
        <p className="text-sm text-[var(--ink-soft)]">
          Only the workspace owner can send what is due. Everyone else can browse the queue below.
        </p>
      </Card>
    );
  }

  const canReview = sendEnabled && initialTotalDue > 0;
  const idleReason = sendEnabled
    ? "Nothing is due right now. Queue an approved email to a contact to build up the queue."
    : "Sending is switched off for this workspace. Messages are checked and recorded but nothing leaves.";

  return (
    <Card className="mb-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-[var(--ink)]">Send what is due</h2>
          <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
            {step === "idle" ? idleReason : "Reviews every due message before anything leaves."}
          </p>
        </div>
        {step === "idle" ? (
          <Button variant={canReview ? "accent" : "secondary"} onClick={openReview} disabled={busy || !canReview}>
            Review what is due
          </Button>
        ) : (
          <Button variant="secondary" onClick={close} disabled={busy}>
            Close
          </Button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-[var(--bad)]">{error}</p>}

      {step === "review" && summary && (
        <div className="mt-4 border-t border-[var(--rule)] pt-4">
          <p className="text-sm text-[var(--ink)]">
            {summary.sendEnabled ? (
              <>
                <span className="font-medium">Sending is switched on for this workspace.</span> Messages that pass
                every check below will actually send.
              </>
            ) : (
              <>
                <span className="font-medium">Sending is switched off for this workspace.</span> Messages are
                checked and recorded but nothing leaves.
              </>
            )}
          </p>

          <p className="mt-3 text-sm text-[var(--ink)]">
            <span className="font-medium">{summary.totalDue}</span> message{summary.totalDue === 1 ? "" : "s"} due
            right now{summary.unassignedDue > 0 ? `, including ${summary.unassignedDue} with no mailbox assigned` : ""}.
          </p>

          {summary.byMailbox.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--ink-soft)]">No mailbox has a message due right now.</p>
          ) : (
            <ul className="mt-2 divide-y divide-[var(--rule)] rounded-[12px] bg-[var(--paper)]">
              {summary.byMailbox.map((m) => (
                <li key={m.mailbox} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="text-[var(--ink)]">{m.mailbox}</span>
                  <span className="text-[var(--ink-soft)]">
                    {m.due} due, {m.remainingToday} left of today&apos;s allowance
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex justify-end">
            <Button
              variant={summary.sendEnabled ? "accent" : "secondary"}
              onClick={confirmSend}
              disabled={busy || summary.totalDue === 0}
            >
              {summary.sendEnabled ? "Confirm and send" : "Confirm and check only"}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && results && (
        <div className="mt-4 border-t border-[var(--rule)] pt-4">
          <p className="text-sm font-medium text-[var(--ink)]">
            {results.length === 0 ? "Nothing was due." : `Processed ${results.length} message${results.length === 1 ? "" : "s"}.`}
          </p>
          {results.length > 0 && (
            <ul className="mt-2 divide-y divide-[var(--rule)] rounded-[12px] bg-[var(--paper)]">
              {results.map((r) => (
                <li key={r.messageId} className="px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <a href={`/outbound/queue/${r.messageId}`} className="text-[var(--ink)] hover:underline">
                      Message #{r.messageId}
                    </a>
                    <StatusLabel kind={r.status === "sent" ? "ok" : r.status === "failed" ? "stop" : "warn"}>
                      {r.status === "sent" ? "Sent" : r.status === "failed" ? "Failed" : "Held"}
                    </StatusLabel>
                  </div>
                  {r.detail && <p className="mt-1 text-xs text-[var(--ink-soft)]">{translateReason(r.detail)}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
