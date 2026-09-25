// Labeled read-only field for detail views: a small stat chip (soft paper
// background, 12px label, 15px bold value) so a detail page's key facts read
// as a row of chips rather than a plain label/value list.
export function Field({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="rounded-[12px] bg-[var(--paper)] px-3.5 py-2.5">
      <div className="text-[12px] font-semibold text-[var(--ink-soft)]">{label}</div>
      <div className="mt-0.5 text-[15px] font-bold text-[var(--ink)]">
        {value === undefined || value === null || value === "" ? (
          <span className="text-[var(--ink-faint)]">Not set</span>
        ) : (
          value
        )}
      </div>
    </div>
  );
}

// Labeled form control wrapper: label + input/select/textarea child, consistent spacing.
import { TriangleAlertIcon } from "../ui/icons";

export function FieldInput({
  label,
  htmlFor,
  children,
  hint,
  error,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
  hint?: string;
  error?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-[var(--ink)]">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--bad)]">
          <TriangleAlertIcon className="shrink-0" />
          <span>{error}</span>
        </p>
      ) : (
        hint && <p className="mt-1 text-xs text-[var(--ink-faint)]">{hint}</p>
      )}
    </div>
  );
}

export const inputClass =
  "w-full h-[44px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-[16px] text-[var(--ink)] outline-none focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]/30";
