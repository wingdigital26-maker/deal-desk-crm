// 4Degrees Deal List import: the pure half. Column detection, stage and pass
// reason parsing, dates, names and locations. No database, no node:* imports,
// so the import screen can use it in the browser and the server can use it too.
import type { BuyerStage } from "./buyerStages";

export const IMPORT_FIELDS = [
  { key: "company", label: "Company", required: true },
  { key: "domain", label: "Website or domain" },
  { key: "contact", label: "Primary contact" },
  { key: "contact_email", label: "Contact email" },
  { key: "contact_title", label: "Contact title" },
  { key: "stage", label: "Stage" },
  { key: "outcome", label: "Outcome" },
  { key: "notes", label: "Notes" },
  { key: "last_interaction", label: "Last interaction" },
  { key: "location", label: "Location" },
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number]["key"];
export type ImportMapping = Partial<Record<ImportField, string>>;

/** Lowercase, letters and digits only: "Company / Contact" -> "companycontact". */
export const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

const SYNONYMS: Record<ImportField, string[]> = {
  company: ["companycontact", "company", "companyname", "organization", "organisation", "firm", "buyer", "buyername", "account", "name"],
  domain: ["domain", "website", "companywebsite", "companydomain", "url", "web", "websiteurl"],
  contact: ["primarycontact", "primarycontactname", "contact", "contactname", "keycontact", "person"],
  contact_email: ["primarycontactemail", "contactemail", "email", "emailaddress"],
  contact_title: ["primarycontacttitle", "contacttitle", "title", "jobtitle"],
  stage: ["stage", "liststage", "dealstage", "status", "pipelinestage"],
  outcome: ["outcome", "passreason", "reason", "declinereason", "result"],
  notes: ["notes", "note", "comments", "comment", "description"],
  last_interaction: ["lastinteraction", "lastinteractiondate", "lastcontacted", "lastcontact", "lastactivity", "lastactivitydate", "lasttouch", "lastemail"],
  location: ["location", "hq", "headquarters", "citystate", "city"],
};

/**
 * Best guess at which CSV header feeds each field. Exact synonym first (in
 * synonym order), then a header that starts with a synonym. Each header is
 * used at most once. The banker confirms or fixes it on the preview screen.
 */
export function detectMapping(headers: string[]): ImportMapping {
  const out: ImportMapping = {};
  const used = new Set<string>();
  const norm = headers.map(normHeader);
  for (const f of IMPORT_FIELDS) {
    for (const syn of SYNONYMS[f.key]) {
      const i = norm.findIndex((h, idx) => h === syn && !used.has(headers[idx]));
      if (i >= 0) {
        out[f.key] = headers[i];
        used.add(headers[i]);
        break;
      }
    }
  }
  for (const f of IMPORT_FIELDS) {
    if (out[f.key]) continue;
    for (const syn of SYNONYMS[f.key]) {
      if (syn.length < 5) continue;
      const i = norm.findIndex((h, idx) => h.startsWith(syn) && !used.has(headers[idx]));
      if (i >= 0) {
        out[f.key] = headers[i];
        used.add(headers[i]);
        break;
      }
    }
  }
  return out;
}

// ---- stages ----

// 4Degrees stage numbers as bankers usually set them up: 3 is "NDA Sent" and
// 5 is "CIM Sent". Words always win over the number when both are present.
const NUMBER_STAGES: Record<number, Exclude<BuyerStage, "declined">> = {
  0: "teaser_sent",
  1: "teaser_sent",
  2: "teaser_sent",
  3: "nda_sent",
  4: "nda_signed",
  5: "cim_sent",
  6: "ioi",
  7: "mgmt_meeting",
  8: "loi",
  9: "exclusivity",
  10: "closed",
};

const PASS_RE = /\b(pass|passed|declin\w*|dead|not interested|dropped|withdr\w*|lost|no go)\b/i;

/** Words only, never the number. Returns null when no stage words are found. */
export function stageFromWords(text: string): BuyerStage | null {
  const t = text.toLowerCase();
  if (PASS_RE.test(t)) return "declined";
  if (/exclusiv/.test(t)) return "exclusivity";
  if (/\bclos(ed|ing)\b/.test(t)) return "closed";
  if (/\bloi\b|letter of intent/.test(t)) return "loi";
  if (/\bmgmt\b|management|site visit|\bmeeting\b/.test(t)) return "mgmt_meeting";
  if (/\bioi\b|indication/.test(t)) return "ioi";
  if (/\bcim\b|\bcip\b|offering memo|information memo|confidential information/.test(t)) return "cim_sent";
  if (/\bnda\b|non.?disclosure|confidentiality/.test(t)) {
    return /sign|execut|return|received|countersign/.test(t) ? "nda_signed" : "nda_sent";
  }
  if (/teaser|contacted|outreach|reached out|\bsent\b/.test(t)) return "teaser_sent";
  return null;
}

/** Leading stage number ("3 - NDA Sent" -> 3), or null. */
export function stageNumber(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2})\b/);
  return m ? Number(m[1]) : null;
}

/** Forward stage for a stage cell: words first, then the leading number. */
export function forwardStage(text: string): Exclude<BuyerStage, "declined"> | null {
  const w = stageFromWords(text);
  if (w && w !== "declined") return w;
  const n = stageNumber(text);
  return n != null && n in NUMBER_STAGES ? NUMBER_STAGES[n] : null;
}

const stripQuotes = (s: string) => s.trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();

export type StagePlan = {
  stage: BuyerStage;
  declined_from_stage: Exclude<BuyerStage, "declined"> | null;
  decline_reason: string | null;
  /** Set when the stage cell was not understood and the row fell back to Teaser sent. */
  warning: string | null;
};

/**
 * Stage cell plus Outcome cell -> where the buyer sits on the log.
 * "Pass" / "Declined" in the stage, or an outcome that starts with "Pass",
 * means declined. The reason is the outcome with its "Pass - " prefix, any
 * stage hint and quotes stripped. declined_from_stage comes from a stage hint
 * in the outcome ("Pass - CIM Sent - ..."), else the stage cell, else teaser_sent.
 */
export function planStage(stageCell: string, outcomeCell: string): StagePlan {
  const stageText = stripQuotes(stageCell ?? "");
  const outcome = stripQuotes(outcomeCell ?? "");
  const stageWords = stageText ? stageFromWords(stageText) : null;
  const outcomeSaysPass = /^(pass(ed)?|declined?)\b/i.test(outcome);

  if (stageWords === "declined" || outcomeSaysPass) {
    // Split "Pass - CIM Sent - Too small" into its dash or colon separated parts.
    const parts = outcome.split(/\s+[-–:]\s+|\s*:\s+/).map(stripQuotes).filter(Boolean);
    if (parts.length && /^(pass(ed)?|declined?)$/i.test(parts[0])) parts.shift();
    else if (parts.length) parts[0] = stripQuotes(parts[0].replace(/^(pass(ed)?|declined?)\b[\s,.:-]*/i, ""));
    let from: Exclude<BuyerStage, "declined"> | null = null;
    // A short leading part that reads as a stage is the hint, not the reason.
    while (parts.length && parts[0].split(/\s+/).length <= 4) {
      const hint = forwardStage(parts[0]);
      if (!hint) break;
      from = from ?? hint;
      parts.shift();
    }
    const reason = stripQuotes(parts.filter(Boolean).join(" - "));
    return {
      stage: "declined",
      declined_from_stage: from ?? forwardStage(stageText) ?? "teaser_sent",
      decline_reason: reason || "Passed (imported)",
      warning: null,
    };
  }
  if (!stageText) return { stage: "teaser_sent", declined_from_stage: null, decline_reason: null, warning: null };
  const fwd = forwardStage(stageText);
  if (fwd) return { stage: fwd, declined_from_stage: null, decline_reason: null, warning: null };
  return { stage: "teaser_sent", declined_from_stage: null, decline_reason: null, warning: `Stage "${stageText}" not recognised, added at Teaser sent` };
}

// ---- dates, names, places ----

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoFrom(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime()) || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** "Sep 24, 2026", "September 24 2026", "2026-09-24", "9/24/2026", "09/24/26" -> "2026-09-24". Null when unreadable. */
export function parseDate(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return isoFrom(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return isoFrom(+m[3], +m[1], +m[2]);
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return mi >= 0 ? isoFrom(+m[3], mi + 1, +m[2]) : null;
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mi >= 0 ? isoFrom(+m[3], mi + 1, +m[1]) : null;
  }
  return null;
}

/** "Jane Q. Doe" -> Jane / Q. Doe; "Doe, Jane" -> Jane / Doe. Only the first person when several are listed. */
export function splitName(raw: string): { first: string | null; last: string | null } {
  let s = (raw ?? "").split(/[;\n|]| and | & /)[0].replace(/\(.*?\)|<.*?>/g, "").trim();
  if (!s) return { first: null, last: null };
  if (/,/.test(s)) {
    const [last, first] = s.split(",").map((p) => p.trim());
    if (first) return { first, last: last || null };
    s = last;
  }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** "Nashville, Tn" -> Nashville / TN. A lone word is treated as the city. */
export function parseLocation(raw: string): { city: string | null; state: string | null } {
  const s = (raw ?? "").trim();
  if (!s) return { city: null, state: null };
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const city = parts[0] || null;
  let state = parts[1] || null;
  if (state && /^[a-z]{2}$/i.test(state)) state = state.toUpperCase();
  return { city, state };
}

export const normDomain = (s: string) =>
  s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
