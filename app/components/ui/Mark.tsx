// The one owned typographic device: the product initials (from firm.config,
// never hardcoded) set in the display serif inside a square ruled frame,
// with a double rule beneath like a ledger total line. Scales from the
// sidebar header (28px) to the sign-in screen (about 120px). Decorative:
// the firm and product name are always set as real text beside it.
import { firm } from "../../../firm.config";

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

export default function Mark({
  size = 28,
  tone = "dark",
}: {
  size?: number;
  tone?: "dark" | "light";
}) {
  const letters = initialsOf(firm.productName);
  const frameClass = tone === "light" ? "border-white/35 text-white" : "border-[var(--rule-strong)] text-[var(--ink)]";
  const ruleClass = tone === "light" ? "bg-white/35" : "bg-[var(--rule-strong)]";

  return (
    <span
      aria-hidden
      className={`inline-flex flex-shrink-0 flex-col items-center justify-center border ${frameClass}`}
      style={{ width: size, height: size }}
    >
      <span className="display" style={{ fontSize: Math.round(size * 0.38), lineHeight: 1 }}>
        {letters}
      </span>
      <span className="flex flex-col" style={{ width: Math.round(size * 0.58), marginTop: Math.round(size * 0.1), gap: 2 }}>
        <span className={`block h-px ${ruleClass}`} />
        <span className={`block h-px ${ruleClass}`} />
      </span>
    </span>
  );
}
