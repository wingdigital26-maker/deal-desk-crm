// Renders template text with {{merge_field}} tokens visibly marked, so a
// reviewer can see exactly which parts of the email personalize per recipient.
const FIELD_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export default function MarkedFieldText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(FIELD_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(
      <span
        key={key++}
        className="rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-1 py-0.5 text-[var(--accent)]"
      >
        {`{{${match[1]}}}`}
      </span>
    );
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
