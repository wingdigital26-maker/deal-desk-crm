// V2 card: white surface, 18px radius, soft shadow, no border. The base container for grouped content.
export default function Panel({
  title,
  actions,
  padded = true,
  className = "",
  children,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  padded?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
          {title && <h2 className="text-[16px] font-bold text-[var(--ink)]">{title}</h2>}
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}
