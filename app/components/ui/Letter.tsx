// Read-only rendering of an email as a quiet document on a sheet.
// Never dangerouslySetInnerHTML: body is plain text split into paragraphs.
export type LetterField = string;

function renderWithFields(text: string) {
  const parts = text.split(/(\{\{[^}]+\}\})/g);
  return parts.map((part, i) => {
    if (/^\{\{[^}]+\}\}$/.test(part)) {
      return (
        <span
          key={i}
          className="rounded-[2px] bg-[var(--paper-deep)] px-0.5 underline decoration-[var(--accent)] decoration-2 underline-offset-2"
        >
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export default function Letter({
  subject,
  body,
  footer,
  signatureLines,
  className = "",
}: {
  subject: string;
  body: string;
  footer?: string;
  signatureLines?: string[];
  className?: string;
}) {
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  return (
    <div
      className={`card mx-auto max-w-[66ch] p-6 sm:p-8 ${className}`}
      style={{ fontFamily: "var(--font-body)", fontSize: 16, lineHeight: 1.65 }}
    >
      <p className="mb-4 border-b border-[var(--rule)] pb-4 font-semibold text-[var(--ink)]">
        {renderWithFields(subject)}
      </p>
      <div className="space-y-4 text-[var(--ink)]">
        {paragraphs.map((p, i) => (
          <p key={i} className="whitespace-pre-wrap">
            {renderWithFields(p)}
          </p>
        ))}
      </div>
      {signatureLines && signatureLines.length > 0 && (
        <div className="mt-6 text-[var(--ink)]">
          {signatureLines.map((line, i) => (
            <p key={i}>{renderWithFields(line)}</p>
          ))}
        </div>
      )}
      {footer && (
        <div className="mt-6 border-t border-[var(--rule)] pt-4 text-[13px] text-[var(--ink-faint)]">
          <p className="whitespace-pre-wrap">{renderWithFields(footer)}</p>
        </div>
      )}
    </div>
  );
}
