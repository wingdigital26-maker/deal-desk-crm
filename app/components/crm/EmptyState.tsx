// Honest empty state: says what's missing AND the next action. Never fake numbers.
import { InboxIcon } from "../ui/icons";

export default function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-1 px-6 py-10 text-center">
      <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--tint-sky)] text-[var(--accent-deep)]" aria-hidden>
        <InboxIcon />
      </span>
      <p className="text-[15px] font-bold text-[var(--ink)]">{title}</p>
      {detail && <p className="mt-1 max-w-md text-sm text-[var(--ink-soft)]">{detail}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
