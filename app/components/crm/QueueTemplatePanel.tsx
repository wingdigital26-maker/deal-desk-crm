"use client";
// The one conversion: queue an approved, principal-reviewed email to the
// selected contacts. On desktop (>= 1100px) this is a 420px column that sits
// beside the table, sticky while the table scrolls, never an overlay. Below
// 1100px it becomes a full-screen sheet. Lists only approved templates,
// preselects the one that makes sense, shows the exact approved content
// read-only via the shared Letter (including the legal footer), and previews
// the honest, reconciled outcome before anything is queued. After queuing it
// shows the real per-contact result.
import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import Select from "../ui/Select";
import Letter from "../ui/Letter";
import Countersignature, { parseSqliteDate } from "../ui/Countersignature";
import { footerTemplate } from "../../lib/compliance";
import { emailCheck } from "./format";

type Template = {
  id: number;
  name: string;
  segment_id: string;
  subject: string;
  body: string;
  status: string;
  approved_by?: number | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  content_hash: string;
  footer?: string | null;
};

type SelectedContact = {
  id: number;
  name: string;
  email: string | null;
  email_status: string | null;
  do_not_contact: number | boolean;
  segmentId?: string | null;
};

type QueueResult = { queued: number[]; skipped: { contactId: number; reason: string }[] };

function formatDate(iso: string | null | undefined): string | null {
  const d = parseSqliteDate(iso);
  if (!d) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Picks the template that makes sense to show first: an explicit template
// carried over from another screen wins, then the only approved template,
// then the one whose segment matches most of the selected contacts, then
// simply the most recently approved one.
function pickInitialTemplate(
  approved: Template[],
  contacts: SelectedContact[],
  initialTemplateId?: number
): number | null {
  if (approved.length === 0) return null;
  if (initialTemplateId && approved.some((t) => t.id === initialTemplateId)) return initialTemplateId;
  if (approved.length === 1) return approved[0].id;

  const segmentCounts = new Map<string, number>();
  for (const c of contacts) {
    if (c.segmentId) segmentCounts.set(c.segmentId, (segmentCounts.get(c.segmentId) ?? 0) + 1);
  }
  let majoritySegment: string | null = null;
  let majorityCount = 0;
  for (const [seg, count] of segmentCounts) {
    if (count > majorityCount) {
      majorityCount = count;
      majoritySegment = seg;
    }
  }
  const segmentMatch = majoritySegment ? approved.find((t) => t.segment_id === majoritySegment) : undefined;
  if (segmentMatch) return segmentMatch.id;

  const mostRecent = [...approved].sort((a, b) => (b.approved_at ?? "").localeCompare(a.approved_at ?? ""))[0];
  return mostRecent ? mostRecent.id : null;
}

export default function QueueTemplatePanel({
  contacts,
  initialTemplateId,
  onClose,
}: {
  contacts: SelectedContact[];
  initialTemplateId?: number;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(initialTemplateId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueueResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/templates?status=approved")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const approved = (data.templates ?? []) as Template[];
        setTemplates(approved);
        setTemplateId(pickInitialTemplate(approved, contacts, initialTemplateId));
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load approved templates.");
      });
    return () => {
      cancelled = true;
    };
    // Only re-run when the target template changes: `contacts` is a fresh
    // array each render, and this panel is mounted fresh each time it opens,
    // so the snapshot taken at mount is the right one for the preselect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTemplateId]);

  const selected = templates?.find((t) => t.id === templateId) ?? null;
  const footerText = selected?.footer ?? footerTemplate();

  // Honest preview computed client-side from what we already know about each
  // contact. The send pipe re-checks everything again at queue time.
  const willSkip = contacts
    .map((c) => ({ contact: c, check: emailCheck(c) }))
    .filter((x) => x.check.kind === "stop" || x.check.kind === "none" || x.check.kind === "warn");
  const willQueue = contacts.length - willSkip.length;

  async function confirm() {
    if (!templateId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/outbound/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, contactIds: contacts.map((c) => c.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not queue this template");
      setResult(data as QueueResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue this template");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      className="fixed inset-0 z-50 flex w-full flex-col border-l border-[var(--rule)] bg-[var(--surface)] min-[1100px]:sticky min-[1100px]:inset-auto min-[1100px]:top-4 min-[1100px]:z-auto min-[1100px]:w-[420px] min-[1100px]:shrink-0 min-[1100px]:max-h-[calc(100vh-2rem)]"
      role="dialog"
      aria-label="Queue an approved email"
    >
      <div className="flex-1 overflow-y-auto p-6">
        <h2 className="text-[15px] font-semibold text-[var(--ink)]">Queue an approved email</h2>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          Only content approved by a registered principal can be queued.
        </p>

        {loadError ? (
          <p className="mt-6 text-sm text-[var(--bad)]">{loadError}</p>
        ) : templates === null ? (
          <p className="mt-6 text-sm text-[var(--ink-soft)]">Loading approved templates...</p>
        ) : templates.length === 0 ? (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-[var(--ink-soft)]">
              There are no approved templates yet. A principal has to approve a template before it can be queued.
            </p>
          </div>
        ) : result ? (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-[var(--ink)]">
              Queued <span className="numeric font-medium">{result.queued.length}</span> message
              {result.queued.length === 1 ? "" : "s"}.
              {result.skipped.length > 0 && (
                <>
                  {" "}
                  Skipped <span className="numeric font-medium">{result.skipped.length}</span>.
                </>
              )}
            </p>
            {result.skipped.length > 0 && (
              <ul className="max-h-60 space-y-1 overflow-y-auto rounded-[12px] bg-[var(--paper)] p-3 text-xs text-[var(--ink-soft)]">
                {result.skipped.map((s, i) => (
                  <li key={i}>
                    Contact <span className="numeric">{s.contactId}</span>: {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="mt-6 space-y-5">
            <Select
              id="queue-template"
              label="Template"
              value={templateId ?? ""}
              onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Choose an approved template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>

            {selected && (
              <>
                <Countersignature
                  state="approved"
                  approvedBy={selected.approved_by_name ?? "a registered principal"}
                  date={formatDate(selected.approved_at)}
                  reference={selected.content_hash}
                />
                <Letter subject={selected.subject} body={selected.body} footer={footerText} />
              </>
            )}

            {error && <p className="text-sm text-[var(--bad)]">{error}</p>}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--rule)] p-6">
        {!result && templates && templates.length > 0 && (
          <div className="mb-3 space-y-1">
            <p className="text-sm text-[var(--ink)]">
              <span className="numeric font-medium">{contacts.length}</span> selected.{" "}
              <span className="numeric font-medium">{willQueue}</span> will be queued.
              {willSkip.length > 0 && (
                <>
                  {" "}
                  <span className="numeric font-medium">{willSkip.length}</span> skipped:{" "}
                  {willSkip.map((x) => emailCheck(x.contact).label.toLowerCase()).join(", ")}.
                </>
              )}
            </p>
            {willSkip.length > 0 && (
              <p className="text-sm text-[var(--ink-soft)]">
                Skipped: {willSkip.map((x) => `${x.contact.name} (${emailCheck(x.contact).label.toLowerCase()})`).join(", ")}.
              </p>
            )}
          </div>
        )}

        {result ? (
          <Button className="w-full" onClick={onClose}>
            Done
          </Button>
        ) : templates && templates.length > 0 ? (
          <div className="flex gap-2">
            <Button variant="quiet" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={templateId ? "accent" : "secondary"}
              className="flex-1"
              onClick={confirm}
              disabled={!templateId || busy || willQueue === 0}
            >
              {busy ? "Queuing..." : `Queue ${willQueue} email${willQueue === 1 ? "" : "s"}`}
            </Button>
          </div>
        ) : (
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
        )}
        <p className="mt-3 text-xs text-[var(--ink-faint)]">
          Messages leave on the mailbox schedule. Nothing sends until the owner runs the queue.
        </p>
      </div>
    </aside>
  );
}
