// Small text label for a signal kind. No color-only meaning, no status dots.
const LABELS: Record<string, string> = {
  hiring: "Hiring",
  news: "News",
  filing: "SEC filing",
  contract: "Federal contract",
  recall: "Recall",
  other: "Other",
};

export default function SignalKindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--tint-2)] px-2.5 py-1 text-xs font-semibold text-[var(--ink-soft)]">
      {LABELS[kind] || kind}
    </span>
  );
}
