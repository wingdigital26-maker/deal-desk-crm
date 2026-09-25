"use client";
// Generic activity timeline: newest first, plus an add-note form.
// Parent supplies the activities and the POST target (company or contact scoped).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass } from "../ui/Button";
import { ActivityIcon } from "../ui/icons";

export type Activity = {
  id: number;
  kind: string;
  body: string | null;
  created_at: string;
  user_name?: string | null;
};

const KIND_LABEL: Record<string, string> = {
  note: "Note",
  call: "Call",
  "email-out": "Email sent",
  "email-in": "Email received",
  "stage-change": "Stage change",
  signal: "Signal",
  import: "Import",
};

// Fixed locale + timezone (not `undefined`, which resolves to the runtime's
// own locale/timezone): the server renders in UTC while a visitor's browser
// renders in whatever zone they are in, so the two disagree and React throws
// a #418 hydration mismatch on this string. Pinning both makes server and
// client render byte-identical text.
function formatWhen(iso: string): string {
  try {
    return new Date(iso.replace(" ", "T") + "Z").toLocaleString("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function Timeline({
  activities,
  postUrl,
  extra,
}: {
  activities: Activity[];
  postUrl: string;
  /** Extra fields merged into the POST body, e.g. { company_id: 12 }. */
  extra?: Record<string, number>;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "note", body: body.trim(), ...extra }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not add the note");
      }
      setBody("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the note");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a note to the timeline"
          rows={2}
          className="min-h-[44px] w-full flex-1 rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus-visible:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={busy || !body.trim()}
          className={buttonClass("secondary", "md", "", busy || !body.trim())}
        >
          {busy ? "Adding..." : "Add note"}
        </button>
      </form>
      {error && <p className="mb-3 text-sm text-[var(--bad)]">{error}</p>}

      {activities.length === 0 ? (
        <p className="text-sm text-[var(--ink-faint)]">No activity yet. Add the first note above.</p>
      ) : (
        <ol className="space-y-4">
          {activities.map((a) => (
            <li key={a.id} className="flex items-start gap-3">
              <span
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--tint-1)] text-[var(--ink-soft)]"
                aria-hidden
              >
                <ActivityIcon />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-[var(--ink-faint)]">
                  <span className="font-medium text-[var(--ink-soft)]">{KIND_LABEL[a.kind] ?? a.kind}</span>
                  <span className="numeric">{formatWhen(a.created_at)}</span>
                  {a.user_name && <span>by {a.user_name}</span>}
                </div>
                {a.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--ink)] [overflow-wrap:anywhere]">{a.body}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
