// Shared date helpers for the pipeline + tasks + today surfaces.
// Dates in the DB are stored as plain "YYYY-MM-DD" (due dates, no timezone:
// compared against the LOCAL calendar date, never a UTC timestamp) or
// SQLite datetime("now") strings (created_at/updated_at, UTC, "YYYY-MM-DD HH:MM:SS").

export function todayISO(): string {
  // Local calendar date, not UTC: at 11pm local (which can already be a new
  // UTC day, or the reverse near UTC midnight west of it) this must still
  // match the date on the wall clock where the banker is sitting.
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isOverdue(due: string | null | undefined): boolean {
  if (!due) return false;
  return due.slice(0, 10) < todayISO();
}

export function isToday(due: string | null | undefined): boolean {
  if (!due) return false;
  return due.slice(0, 10) === todayISO();
}

export function isThisWeek(due: string | null | undefined): boolean {
  if (!due) return false;
  const d = due.slice(0, 10);
  const today = new Date();
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const dueDate = new Date(d + "T00:00:00");
  return dueDate.getTime() >= start.getTime() && dueDate.getTime() < end.getTime() && d !== todayISO();
}

export function daysUntil(due: string | null | undefined): number | null {
  if (!due) return null;
  const dueDate = new Date(due.slice(0, 10) + "T00:00:00");
  const today = new Date(todayISO() + "T00:00:00");
  return Math.round((dueDate.getTime() - today.getTime()) / 86400000);
}

export function daysSince(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const then = new Date(timestamp.replace(" ", "T") + "Z");
  const now = new Date();
  return Math.floor((now.getTime() - then.getTime()) / 86400000);
}

export function formatDate(due: string | null | undefined): string {
  if (!due) return "No date";
  const d = new Date(due.slice(0, 10) + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts.replace(" ", "T") + "Z");
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
