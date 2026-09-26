// The one "what matters" label for a deal (app/lib/attention.ts): icon plus
// words, never colour alone, never a dot.
import StatusLabel from "../ui/StatusLabel";
import { TriangleAlertIcon } from "../ui/icons";
import type { Attention } from "../../lib/attention";

export default function AttentionLabel({ a, className = "" }: { a: Pick<Attention, "label"> | null | undefined; className?: string }) {
  if (!a?.label) return null;
  const { tone, text } = a.label;
  return (
    <StatusLabel
      kind={tone}
      icon={tone === "stop" ? TriangleAlertIcon : undefined}
      className={`shrink-0 whitespace-nowrap !px-2 !py-0.5 ${className}`}
    >
      {text}
    </StatusLabel>
  );
}
