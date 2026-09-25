// Shared by server pages and client components (no "use client" here on purpose).
//
// SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" in UTC with no "T" and
// no zone. `new Date()` treats that as local time or rejects it, which silently
// shifts or breaks the one fact an approval record exists to state. This adds
// the "T" and "Z" a real ISO string needs, and returns null (never a fallback
// string) when the value is missing or unparseable, so callers omit the fact.
export function parseSqliteDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const needsIsoFixup = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
  const iso = needsIsoFixup ? `${value.replace(" ", "T")}Z` : value;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function humanDate(value: string | null | undefined): string | null {
  const d = parseSqliteDate(value);
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
}
