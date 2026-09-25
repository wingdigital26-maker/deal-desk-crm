// Status = icon plus word in a soft tinted pill (Dashboards V2). Never colour alone.
import { CheckIcon, CircleIIcon, TriangleAlertIcon, CircleSlashIcon, CircleIcon } from "./icons";

export type StatusKind = "ok" | "info" | "warn" | "stop" | "none";

const ICON: Record<StatusKind, typeof CheckIcon> = {
  ok: CheckIcon,
  info: CircleIIcon,
  warn: TriangleAlertIcon,
  stop: CircleSlashIcon,
  none: CircleIcon,
};

const COLOR: Record<StatusKind, string> = {
  ok: "text-[var(--good)] bg-[var(--status-ok-bg)]",
  info: "text-[var(--ink-soft)] bg-[var(--status-info-bg)]",
  warn: "text-[var(--warn)] bg-[var(--status-warn-bg)]",
  stop: "text-[var(--bad)] bg-[var(--status-stop-bg)]",
  none: "text-[var(--ink-soft)] bg-[var(--status-none-bg)]",
};

export default function StatusLabel({
  kind,
  children,
  className = "",
}: {
  kind: StatusKind;
  children: React.ReactNode;
  className?: string;
}) {
  const Icon = ICON[kind];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${COLOR[kind]} ${className}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </span>
  );
}
