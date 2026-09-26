// "Export" control for a list header: two plain download links (CSV, Excel)
// carrying the list's current filters. No client state, so it renders the same
// from a server page or a client component.
import { buttonClass } from "../ui/Button";

export type ExportEntity = "companies" | "contacts" | "deals" | "tasks" | "referrals";

export default function ExportLinks({ entity, query = "" }: { entity: ExportEntity; query?: string }) {
  const href = (format: "csv" | "xlsx") => `/api/export/${entity}?${query ? `${query}&` : ""}format=${format}`;
  return (
    <div role="group" aria-label="Export this list" className="flex items-center gap-1">
      <span className="label hidden pr-1 text-[var(--ink-soft)] sm:inline">Export</span>
      <a href={href("csv")} download className={buttonClass("secondary", "sm")}>
        CSV
      </a>
      <a href={href("xlsx")} download className={buttonClass("secondary", "sm")}>
        Excel
      </a>
    </div>
  );
}
