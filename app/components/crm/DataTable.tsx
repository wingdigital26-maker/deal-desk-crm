// Generic dense data table. Desktop: real table. Mobile (<768px): stacked
// cards, one per row, each cell rendered as "label: value" so nothing is lost.
export type Column<T> = {
  key: string;
  label: string;
  render: (row: T) => React.ReactNode;
  className?: string;
  /** 1 = always shown, 2 = hides below 1100px, 3 = hides below 900px. Default 1. */
  priority?: 1 | 2 | 3;
  /** Truncate with a title attribute instead of wrapping. */
  truncate?: boolean;
  /** This column takes whatever width is left and truncates with a title
   * attribute, same mechanics as `truncate`. Use when a table needs more than
   * one flexible text column (e.g. Subject + First line), since both can be
   * marked `flex` and will share the remaining space. Also fine on the first
   * column (e.g. a long registry name) — the row link truncates with it. */
  flex?: boolean;
  /** Optional target width, as a percentage of the table, for a `flex`
   * column when two or more flex columns should NOT split the remaining
   * space evenly (e.g. Subject at 30, First line taking the rest). Applied
   * as an inline style so it holds regardless of Tailwind class ordering. */
  widthPct?: number;
};

function priorityClass(p?: 1 | 2 | 3) {
  if (p === 3) return "hidden min-[900px]:table-cell";
  if (p === 2) return "hidden min-[1100px]:table-cell";
  return "";
}

// Header cells are ALWAYS the plain .label role (11px tracked uppercase) so
// every column head reads the same weight and size. A column's own
// className (e.g. "numeric text-right", used to make a body cell's figures
// tabular and right-aligned) is for the td only; only its alignment carries
// over to the th, never the numeric/type styling that made round 3's last
// header cell render larger and lighter than the rest.
function thAlignClass(className?: string): string {
  if (!className) return "text-left";
  if (className.includes("text-right")) return "text-right";
  if (className.includes("text-center")) return "text-center";
  return "text-left";
}

// Optional row-selection support. Passing `selection` adds a checkbox column
// (desktop and mobile) with a header "select all on this page" checkbox.
// Existing callers that omit `selection` are unaffected.
export type Selection<T extends { id: number | string }> = {
  selectedIds: Set<T["id"]>;
  onToggleRow: (id: T["id"]) => void;
  onToggleAll: (ids: T["id"][], checked: boolean) => void;
};

export default function DataTable<T extends { id: number | string }>({
  columns,
  rows,
  rowHref,
  selection,
  bare = false,
}: {
  columns: Column<T>[];
  rows: T[];
  rowHref?: (row: T) => string;
  selection?: Selection<T>;
  /** Drop this table's own outer border/radius when a Panel already frames
   * it, so a list never gets two nested frames for one thing. */
  bare?: boolean;
}) {
  const pageIds = rows.map((r) => r.id);
  const allSelectedOnPage = selection ? pageIds.length > 0 && pageIds.every((id) => selection.selectedIds.has(id)) : false;

  return (
    <div className={bare ? "overflow-hidden bg-[var(--surface)]" : "card overflow-hidden"}>
      {/* Desktop table */}
      <table className="hidden w-full border-collapse text-sm md:table">
        <thead>
          <tr className="border-b border-[var(--rule)]">
            {selection && (
              <th className="w-10 px-4 py-2 text-left">
                <input
                  type="checkbox"
                  aria-label="Select all rows on this page"
                  checked={allSelectedOnPage}
                  onChange={(e) => selection.onToggleAll(pageIds, e.target.checked)}
                  className="h-4 w-4 rounded border-[var(--rule)]"
                />
              </th>
            )}
            {columns.map((c) => (
              <th
                key={c.key}
                className={`whitespace-nowrap px-5 py-3.5 text-xs font-semibold text-[var(--ink-soft)] ${thAlignClass(c.className)} ${priorityClass(c.priority)}`}
                style={c.widthPct ? { width: `${c.widthPct}%` } : undefined}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = rowHref?.(row);
            const checked = selection ? selection.selectedIds.has(row.id) : false;
            return (
              <tr
                key={row.id}
                className={`h-[var(--row-h)] border-b border-[var(--rule)] transition-colors last:border-0 hover:bg-[var(--paper-deep)] ${
                  checked ? "bg-[var(--paper-deep)]" : "hover:bg-[var(--paper)]"
                }`}
              >
                {selection && (
                  <td className="whitespace-nowrap px-4 py-2 align-middle">
                    <input
                      type="checkbox"
                      aria-label={`Select row ${row.id}`}
                      checked={checked}
                      onChange={() => selection.onToggleRow(row.id)}
                      className="h-4 w-4 rounded border-[var(--rule)]"
                    />
                  </td>
                )}
                {columns.map((c, idx) => {
                  // A column can opt into being the ONE flexible column: it takes
                  // whatever width is left and truncates with a title attribute.
                  // Every other column is single-line, nowrap, sized to content
                  // (or to its own className) so rows stay one equal height.
                  const flexible = c.truncate || c.flex;
                  const cellContent = c.render(row);
                  return (
                    <td
                      key={c.key}
                      className={`px-5 py-2 align-middle text-[var(--ink)] ${priorityClass(c.priority)} ${
                        flexible
                          ? "max-w-[1px] w-full overflow-hidden text-ellipsis whitespace-nowrap"
                          : "whitespace-nowrap"
                      } ${c.className ?? ""}`}
                      style={c.widthPct ? { width: `${c.widthPct}%` } : undefined}
                      title={flexible && typeof cellContent === "string" ? cellContent : undefined}
                    >
                      {idx === 0 && href ? (
                        <a
                          href={href}
                          className={`font-medium text-[var(--ink)] hover:text-[var(--accent)] ${flexible ? "block truncate" : ""}`}
                        >
                          {cellContent}
                        </a>
                      ) : (
                        cellContent
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Mobile stacked cards */}
      <ul className="divide-y divide-[var(--rule)] md:hidden">
        {selection && rows.length > 0 && (
          <li className="flex items-center gap-2 px-4 py-2.5 text-xs text-[var(--ink-soft)]">
            <input
              type="checkbox"
              aria-label="Select all rows on this page"
              checked={allSelectedOnPage}
              onChange={(e) => selection.onToggleAll(pageIds, e.target.checked)}
              className="h-4 w-4 rounded border-[var(--rule)]"
            />
            Select all on this page
          </li>
        )}
        {rows.map((row) => {
          const href = rowHref?.(row);
          const checked = selection ? selection.selectedIds.has(row.id) : false;
          // Only the first line links to the row. Wrapping the whole row in a link
          // nests anchors whenever a cell renders its own link (invalid HTML, and
          // React fails hydration on it).
          const content = columns.map((c, idx) => (
            <div key={c.key} className={idx === 0 ? "text-sm font-medium text-[var(--ink)]" : "mt-1 text-xs text-[var(--ink-soft)]"}>
              {idx > 0 && <span className="text-[var(--ink-faint)]">{c.label}: </span>}
              {idx === 0 && href ? (
                <a href={href} className="flex min-h-[44px] items-center break-words hover:text-[var(--accent)]">
                  {c.render(row)}
                </a>
              ) : (
                c.render(row)
              )}
            </div>
          ));
          return (
            <li key={row.id} className="flex items-start gap-3 px-4 py-3">
              {selection && (
                <input
                  type="checkbox"
                  aria-label={`Select row ${row.id}`}
                  checked={checked}
                  onChange={() => selection.onToggleRow(row.id)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-[var(--rule)]"
                />
              )}
              <div className="block min-w-0 flex-1">{content}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
