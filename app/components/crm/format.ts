// Small, pure display helpers shared by the contacts/companies screens.
// No raw hex, no fake data: every function here formats real values only.
import type { StatusKind } from "../ui/StatusLabel";

export function relativeDays(iso: string | null | undefined): string {
  if (!iso) return "No touch yet";
  const then = new Date(iso.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(then)) return "No touch yet";
  const days = Math.max(0, Math.floor((Date.now() - then) / 86400000));
  if (days === 0) return "Today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

export type EmailCheck = { kind: StatusKind; label: string };

// do_not_contact overrides every other read on the contact's email.
export function emailCheck(contact: { email: string | null; email_status?: string | null; do_not_contact: number | boolean }): EmailCheck {
  if (contact.do_not_contact) return { kind: "stop", label: "Do not contact" };
  if (!contact.email) return { kind: "none", label: "No email yet" };
  switch (contact.email_status) {
    case "valid":
    case "verified": // Apollo's word for the same thing
      return { kind: "ok", label: "Verified" };
    case "accept-all":
      return { kind: "info", label: "Accepts all mail" };
    case "no-mx":
      return { kind: "warn", label: "No mail server" };
    default:
      return { kind: "none", label: "Not checked" };
  }
}

// email_status values that read as "Verified". Apollo imports write
// "verified"; the signal collector writes "valid". Keep the filter on
// /contacts and emailCheck() above in step with each other.
export const VERIFIED_EMAIL_STATUSES = ["valid", "verified"] as const;
// Every status with its own label; anything else with an address is "Not checked".
export const LABELLED_EMAIL_STATUSES = [...VERIFIED_EMAIL_STATUSES, "accept-all", "no-mx"] as const;

export const EMAIL_CHECK_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Any" },
  { value: "valid", label: "Verified" },
  { value: "accept-all", label: "Accepts all mail" },
  { value: "unknown", label: "Not checked" },
  { value: "no-mx", label: "No mail server" },
  { value: "no-email", label: "No email yet" },
  { value: "dnc", label: "Do not contact" },
];

export function displayName(c: { first_name: string | null; last_name: string | null }): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed";
}

// Company names come out of a state registry in ALL CAPS. Title-case them for
// display only (the database keeps the original casing) and keep known
// acronyms and roman numerals upper.
const COMPANY_ACRONYMS = new Set(["LLC", "LP", "LLP", "PLLC", "USA", "TX", "II", "III", "IV", "DBA"]);
const COMPANY_SMALL_WORDS = new Set(["of", "and", "the", "for", "in", "on", "at", "by", "a", "an"]);

export function titleCaseCompanyName(name: string): string {
  let seenWord = false;
  return name
    .split(/(\s+)/)
    .map((token) => {
      if (token.trim() === "") return token;
      const isFirst = !seenWord;
      seenWord = true;
      const bare = token.replace(/[.,]/g, "").toUpperCase();
      if (COMPANY_ACRONYMS.has(bare)) return token.toUpperCase();
      if (!isFirst && COMPANY_SMALL_WORDS.has(token.toLowerCase())) return token.toLowerCase();
      return token.toLowerCase().replace(/(^|['-])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());
    })
    .join("");
}

// Sourcing feeds use a machine slug (e.g. a scraper's internal name). Map the
// known ones to a reader-friendly label; anything unrecognised passes through
// so a new source never disappears.
const SOURCE_LABELS: Record<string, string> = {
  "tx-franchise-registry": "TX registry",
  manual: "Manual",
  apollo: "Apollo",
  "signal-engine": "Signal engine",
  import: "Import",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}
