"use client";
// FOLLOWUPS: the banker's next step with one buyer (internal, never on the
// seller report). Shows the step and its date with the house overdue / due
// today label; tap to edit the words and the date, or one tap on "In 3 days" /
// "In 1 week" to set the date and save. Saves through PATCH /api/deal-buyers/:id,
// which logs the old and new value like every other term edit.
import { useState } from "react";
import { Button } from "../ui/Button";
import DateInput from "../ui/DateInput";
import { inputClass } from "../crm/Field";
import AttentionLabel from "../pipeline/AttentionLabel";
import { formatDate, todayISO } from "../pipeline/dateUtils";
import { addCalendarDays, FOLLOW_UP_PRESETS, followUpAttention } from "../../lib/followups";

type Buyer = { id: number; buyer_name: string; stage: string; next_step: string | null; next_step_due: string | null };
type Patch = { next_step?: string | null; next_step_due?: string | null };

export default function NextStepEditor({ b, onSave }: { b: Buyer; onSave: (patch: Patch) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(b.next_step ?? "");
  const [due, setDue] = useState(b.next_step_due ?? "");
  const [busy, setBusy] = useState(false);
  const today = todayISO();
  const a = followUpAttention(b, today);

  async function save(patch: Patch) {
    setBusy(true);
    const ok = await onSave(patch);
    setBusy(false);
    if (ok) setEditing(false);
  }

  function open() {
    setText(b.next_step ?? "");
    setDue(b.next_step_due ?? "");
    setEditing(true);
  }

  if (!editing) {
    const empty = !b.next_step && !b.next_step_due;
    return (
      <button
        onClick={open}
        aria-label={empty ? `Add a next step for ${b.buyer_name}` : `Edit the next step for ${b.buyer_name}`}
        className="flex min-h-[44px] w-full min-w-0 flex-col items-start justify-center rounded-[8px] px-1 text-left hover:bg-[var(--paper)]"
      >
        {empty ? (
          <span className="text-[12px] text-[var(--ink-faint)]">Add next step</span>
        ) : (
          <>
            <span className="block w-full truncate text-[13px] text-[var(--ink)]" title={b.next_step ?? ""}>
              {b.next_step || "Follow up"}
            </span>
            {b.next_step_due &&
              (a.label ? (
                <AttentionLabel a={a} className="mt-0.5 !text-[11px]" />
              ) : (
                <span className="numeric text-[12px] text-[var(--ink-soft)]">{formatDate(b.next_step_due)}</span>
              ))}
          </>
        )}
      </button>
    );
  }

  const textPatch = () => text.trim() || null;
  return (
    <div className="flex min-w-[240px] flex-col gap-2 rounded-[10px] bg-[var(--paper)] p-2">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save({ next_step: textPatch(), next_step_due: due || null });
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder="Next step, e.g. Chase NDA markup"
        aria-label={`Next step for ${b.buyer_name}`}
        maxLength={300}
        className={inputClass}
      />
      <DateInput value={due} onChange={(e) => setDue(e.target.value)} aria-label={`Next step date for ${b.buyer_name}`} />
      <div className="flex flex-wrap gap-1.5">
        {FOLLOW_UP_PRESETS.map((p) => (
          <Button
            key={p.days}
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => save({ next_step: textPatch(), next_step_due: addCalendarDays(today, p.days) })}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        {(b.next_step || b.next_step_due) && (
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => save({ next_step: null, next_step_due: null })}>
            Clear
          </Button>
        )}
        <Button size="sm" variant="quiet" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={() => save({ next_step: textPatch(), next_step_due: due || null })}>
          Save
        </Button>
      </div>
    </div>
  );
}
