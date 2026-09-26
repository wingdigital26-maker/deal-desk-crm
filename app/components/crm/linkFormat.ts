// Pure display helpers for a person's company links (role and dates).
function month(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** "Since Mar 2019", "Mar 2019 to Jun 2022", "Until Jun 2022", or "" when no dates are on file. */
export function linkSpan(start: string | null, end: string | null): string {
  if (start && end) return `${month(start)} to ${month(end)}`;
  if (start) return `Since ${month(start)}`;
  if (end) return `Until ${month(end)}`;
  return "";
}

/** A link with an end date in the past is a former role. */
export function isFormer(end: string | null, today = new Date().toISOString().slice(0, 10)): boolean {
  return !!end && end < today;
}
