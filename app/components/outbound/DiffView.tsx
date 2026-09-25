import type { DiffLine } from "../../lib/compliance/diff";

// Document-voice comparison against the last approved version: never a
// code-style diff. Removed text is struck through, added text underlined,
// each carrying a text label rather than colour alone.
export default function DiffView({ lines, label }: { lines: DiffLine[]; label: string }) {
  const changed = lines.some((l) => l.type !== "same");
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-[var(--ink)]">{label}</div>
      {!changed ? (
        <p className="text-sm text-[var(--ink-faint)]">Identical to the last approved version.</p>
      ) : (
        <div className="card space-y-2 p-3 text-[14px] leading-relaxed text-[var(--ink)]">
          {lines.map((l, i) => {
            if (l.type === "same") return null;
            const isAdd = l.type === "add";
            return (
              <p key={i}>
                <span className="label mr-2 text-[var(--ink-faint)]">{isAdd ? "Added" : "Removed"}</span>
                <span className={isAdd ? "underline decoration-[var(--accent)] decoration-2 underline-offset-2" : "text-[var(--ink-faint)] line-through decoration-1"}>
                  {l.text || " "}
                </span>
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}
