// Banker profile: the owner + business view built from profile_facts (written by
// scrapers/profile_enrich.py), the CRM row, and the signal engine's signals.
// Every value on the page carries its source. Anything the sources did not give
// stays null so the UI can show an honest blank. The sell-readiness hints are
// INFERENCE and are labelled that way everywhere they appear.
import { db } from "./db";

export type Confidence = "confirmed" | "unconfirmed";

export type Sourced = {
  value: string;
  sourceUrl: string | null;
  sourceLabel: string;
  fetchedAt: string | null;
  confidence: Confidence;
  note: string | null;
  observedAt: string | null;
};

export type FactRow = {
  field: string;
  value: string;
  source_url: string;
  source_label: string | null;
  confidence: Confidence;
  match_basis: string | null;
  note: string | null;
  observed_at: string | null;
  fetched_at: string;
};

export type CompanyRow = {
  id: number;
  name: string;
  domain: string | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  employees: number | null;
  revenue_band: string | null;
  source: string;
  profile_refreshed_at?: string | null;
};

export type SignalRow = { id: number; kind: string; title: string; url: string | null; observed_at: string | null };

export type WhyNowItem = {
  kind: "hiring" | "expansion" | "facility" | "award" | "ownership" | "news" | "contract";
  title: string;
  url: string | null;
  date: string | null;
  confidence: Confidence;
  sourceLabel: string;
};

export type FitFlag = { level: "poor" | "possible" | "note"; text: string; source: Sourced | null };
export type Hint = { text: string; basis: Sourced[] };

export type Leader = { name: string; title: string; source: Sourced };

export type CompanyProfile = {
  companyId: number;
  companyName: string;
  refreshedAt: string | null;
  owner: {
    name: Sourced | null;
    title: Sourced | null;
    since: Sourced | null;
    bio: Sourced | null;
    linkedin: Sourced | null;
    otherRoles: Sourced[];
    press: Sourced[];
  };
  leaders: Leader[];
  business: {
    legalName: Sourced | null;
    dba: Sourced | null;
    website: Sourced | null;
    summary: Sourced | null;
    industry: Sourced | null;
    naics: Sourced | null;
    foundedYear: Sourced | null;
    formationDate: Sourced | null;
    entityType: Sourced | null;
    sosFileNumber: Sourced | null;
    hqAddress: Sourced | null;
    locations: Sourced[];
    employees: Sourced | null;
    revenueBand: Sourced | null;
    ownershipType: Sourced | null;
    endMarkets: Sourced[];
    certifications: Sourced[];
    linkedin: Sourced | null;
    familyOwnedSince: Sourced | null;
    nextGeneration: Sourced | null;
  };
  whyNow: WhyNowItem[];
  fit: FitFlag[];
  hints: Hint[];
};

const CRM_LABEL = "CRM record (Apollo import)";

function fromFact(f: FactRow): Sourced {
  return {
    value: f.value,
    sourceUrl: f.source_url,
    sourceLabel: f.source_label || hostOf(f.source_url) || "source",
    fetchedAt: f.fetched_at,
    confidence: f.confidence,
    note: f.note,
    observedAt: f.observed_at,
  };
}

function fromCrm(value: string | number | null | undefined, source: string): Sourced | null {
  if (value === null || value === undefined || value === "") return null;
  return {
    value: String(value),
    sourceUrl: null,
    sourceLabel: source === "apollo" ? CRM_LABEL : `CRM record (${source})`,
    fetchedAt: null,
    confidence: "confirmed",
    note: null,
    observedAt: null,
  };
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Same rule as profile_enrich.norm_name: letters and digits only, legal suffixes dropped.
export function normName(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/\b(inc|llc|l\.l\.c|ltd|lp|l\.p|llp|corp|corporation|company|co|the|incorporated|pllc|pc)\b\.?/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

const STATES: Record<string, string> = { TX: "Texas", OK: "Oklahoma", LA: "Louisiana", NM: "New Mexico", AR: "Arkansas" };

// Match discipline for a headline already stored by the signal engine. Mirrors
// profile_enrich.news_match: no name in the headline -> dropped; name plus city,
// state or the company's own domain -> confirmed; name alone -> unconfirmed.
export function matchSignal(title: string, url: string | null, company: Pick<CompanyRow, "name" | "domain" | "city" | "state">): Confidence | null {
  const want = normName(company.name);
  if (want.length < 4 || !normName(title).includes(want)) return null;
  const host = hostOf(url);
  const dom = (company.domain || "").toLowerCase().replace(/^www\./, "");
  if (dom && host && host.endsWith(dom)) return "confirmed";
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (company.city && new RegExp(`\\b${esc(company.city)}\\b`, "i").test(title)) return "confirmed";
  const st = (company.state || "").toUpperCase();
  if (st && (new RegExp(`\\b${st}\\b`).test(title) || (STATES[st] && new RegExp(`\\b${STATES[st]}\\b`, "i").test(title)))) return "confirmed";
  return "unconfirmed";
}

const SIGNAL_FIELD_KIND: Record<string, WhyNowItem["kind"]> = {
  signal_hiring: "hiring",
  signal_expansion: "expansion",
  signal_facility: "facility",
  signal_award: "award",
  signal_ownership: "ownership",
  signal_news: "news",
  ownership_event: "ownership",
};

const EXPANSION_WORDS = /\b(expan\w*|new (?:facility|plant|headquarters)|invest\w*|jobs|relocat\w*)\b/i;
const OWNERSHIP_WORDS = /\b(acqui\w*|private equity|recapitali[sz]\w*|merger|sold)\b/i;

function signalKind(s: SignalRow): WhyNowItem["kind"] {
  if (s.kind === "hiring") return "hiring";
  if (s.kind === "contract") return "contract";
  if (OWNERSHIP_WORDS.test(s.title)) return "ownership";
  if (EXPANSION_WORDS.test(s.title)) return "expansion";
  return "news";
}

const THIS_YEAR = () => new Date().getFullYear();

function yearOf(s: Sourced | null): number | null {
  if (!s) return null;
  const m = s.value.match(/\b(1[89]\d\d|20\d\d)\b/);
  return m ? Number(m[1]) : null;
}

function monthsAgo(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z")).getTime();
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / (30.44 * 86400000);
}

/** Pure: facts + CRM row + signals -> the profile. No database access, so it is unit-tested directly. */
export function buildProfile(company: CompanyRow, facts: FactRow[], signals: SignalRow[], now = new Date()): CompanyProfile {
  const byField = new Map<string, FactRow[]>();
  for (const f of facts) {
    const list = byField.get(f.field) ?? [];
    list.push(f);
    byField.set(f.field, list);
  }
  const one = (field: string): Sourced | null => {
    const rows = byField.get(field);
    if (!rows?.length) return null;
    const best = [...rows].sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "confirmed" ? -1 : 1))[0];
    return fromFact(best);
  };
  const many = (field: string): Sourced[] =>
    (byField.get(field) ?? []).map(fromFact).sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "confirmed" ? -1 : 1));

  const leaders: Leader[] = many("leaders").map((s) => {
    const [name, ...rest] = s.value.split(" | ");
    return { name: name.trim(), title: rest.join(" | ").trim(), source: s };
  });

  const business: CompanyProfile["business"] = {
    legalName: one("legal_name") ?? one("legal_name_site"),
    dba: one("dba"),
    website: one("website") ?? (company.domain ? fromCrm(`https://${company.domain}`, company.source) : null),
    summary: one("summary"),
    industry: fromCrm(company.industry, company.source),
    naics: one("naics"),
    foundedYear: one("founded_year"),
    formationDate: one("formation_date"),
    entityType: one("entity_type"),
    sosFileNumber: one("sos_file_number"),
    hqAddress: one("hq_address") ?? one("registered_address"),
    locations: many("locations"),
    employees: one("employee_estimate") ?? fromCrm(company.employees, company.source),
    revenueBand: fromCrm(company.revenue_band ? formatRevenue(company.revenue_band) : null, company.source),
    ownershipType: one("ownership_type"),
    endMarkets: many("end_markets"),
    certifications: many("certifications"),
    linkedin: one("company_linkedin"),
    familyOwnedSince: one("family_owned_since"),
    nextGeneration: one("second_generation"),
  };

  const owner: CompanyProfile["owner"] = {
    name: one("owner_name"),
    title: one("owner_title"),
    since: one("owner_since"),
    bio: one("owner_bio"),
    linkedin: one("owner_linkedin"),
    otherRoles: many("owner_other_roles"),
    press: many("owner_press"),
  };

  // Why now: profile signals + the signal engine's rows, each through the match discipline.
  const whyNow: WhyNowItem[] = [];
  const seen = new Set<string>();
  const push = (item: WhyNowItem) => {
    const key = `${normName(item.title)}|${item.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    whyNow.push(item);
  };
  for (const [field, kind] of Object.entries(SIGNAL_FIELD_KIND)) {
    for (const f of byField.get(field) ?? []) {
      push({
        kind,
        title: field === "ownership_event" ? (f.note ?? f.value) : f.value,
        url: f.source_url,
        date: f.observed_at,
        confidence: f.confidence,
        sourceLabel: f.source_label || hostOf(f.source_url) || "source",
      });
    }
  }
  for (const s of signals) {
    if (s.kind === "contract") {
      // USAspending recipient matched by name only (see harness_signals.py): never confirmed.
      push({ kind: "contract", title: s.title, url: s.url, date: s.observed_at, confidence: "unconfirmed", sourceLabel: "USAspending" });
      continue;
    }
    const conf = matchSignal(s.title, s.url, company);
    if (!conf) continue; // headline does not name this company: a false attribution, not shown
    push({ kind: signalKind(s), title: s.title, url: s.url, date: s.observed_at, confidence: conf, sourceLabel: hostOf(s.url) || "news" });
  }
  whyNow.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "confirmed" ? -1 : 1;
    return (b.date || "").localeCompare(a.date || "");
  });

  // Fit: poor-fit flags only. No flag is never presented as "good fit".
  const fit: FitFlag[] = [];
  const own = business.ownershipType;
  if (own) {
    const poor: Record<string, string> = {
      public: "Public company or public parent",
      "pe-backed": "PE-backed",
      subsidiary: "Part of a larger group (subsidiary or division)",
    };
    if (poor[own.value]) fit.push({ level: own.confidence === "confirmed" ? "poor" : "possible", text: poor[own.value], source: own });
    if (own.value === "employee-owned") fit.push({ level: "note", text: "Employee-owned (ESOP): a sale runs through the trustee", source: own });
  }
  // Several outlets covering one deal are one flag: the best-tied, most recent report leads.
  const events = many("ownership_event").sort((a, b) =>
    a.confidence !== b.confidence ? (a.confidence === "confirmed" ? -1 : 1) : (b.observedAt || "").localeCompare(a.observedAt || "")
  );
  if (events.length) {
    const lead = events[0];
    const sold = events.some((e) => e.value.startsWith("sold"));
    const label = sold ? "Already sold (reported)" : "PE deal reported";
    const more = events.length > 1 ? ` (${events.length} reports)` : "";
    fit.push({ level: lead.confidence === "confirmed" ? "poor" : "possible", text: `${label}: ${lead.note ?? lead.value}${more}`, source: lead });
  }
  if (business.entityType && /out-of-state/i.test(business.entityType.value)) {
    fit.push({ level: "note", text: `${business.entityType.value} in the Texas registry: may be a branch of an out-of-state parent`, source: business.entityType });
  }
  if (company.state && company.state.toUpperCase() !== "TX") {
    fit.push({ level: "note", text: `Based outside Texas (${company.state})`, source: fromCrm(company.state, company.source) });
  }

  // Sell-readiness hints: inference, each with the facts it rests on.
  const hints: Hint[] = [];
  const founded = yearOf(business.foundedYear) ?? yearOf(business.formationDate);
  const foundedSrc = business.foundedYear ?? business.formationDate;
  const ownerTitle = (owner.title?.value || "").toLowerCase();
  if (founded && foundedSrc) {
    const yrs = THIS_YEAR() - founded;
    if (/found/.test(ownerTitle) && owner.name) {
      hints.push({ text: `Founder-led: ${owner.name.value} founded it in ${founded}, about ${yrs} years ago`, basis: [foundedSrc, owner.title!] });
      if (yrs >= 25) hints.push({ text: `Founder is likely late career (from a ${founded} founding, not a published age)`, basis: [foundedSrc] });
    } else if (yrs >= 30 && !business.familyOwnedSince && !own) {
      hints.push({ text: `${yrs} years in business (since ${founded}): an older business, check who owns it now`, basis: [foundedSrc] });
    }
  }
  const since = yearOf(owner.since);
  if (since && owner.since && owner.name) {
    const yrs = THIS_YEAR() - since;
    hints.push({ text: `${owner.name.value} has run it since ${since} (${yrs} years)${yrs >= 20 ? ": long tenure" : ""}`, basis: [owner.since] });
  }
  if (business.familyOwnedSince) {
    hints.push({ text: `Family owned since ${business.familyOwnedSince.value}`, basis: [business.familyOwnedSince] });
  }
  if (business.nextGeneration) {
    hints.push({ text: "Generational ownership named on the company site: a succession plan may already exist", basis: [business.nextGeneration] });
  } else if (leaders.length > 0 && (own?.value === "family" || /found|owner/.test(ownerTitle))) {
    hints.push({ text: "No second generation named on the company site", basis: [leaders[0].source] });
  }
  for (const w of whyNow) {
    const m = monthsAgo(w.date, now);
    if (w.confidence !== "confirmed" || m === null || m > 24) continue;
    if (w.kind === "expansion" || w.kind === "facility") hints.push({ text: `Recent capex or facility move: ${w.title}`, basis: [signalSource(w)] });
    if (w.kind === "hiring") hints.push({ text: `New senior operating hire or opening: ${w.title}`, basis: [signalSource(w)] });
  }

  return {
    companyId: company.id,
    companyName: company.name,
    refreshedAt: company.profile_refreshed_at ?? null,
    owner,
    leaders,
    business,
    whyNow,
    fit,
    hints,
  };
}

function signalSource(w: WhyNowItem): Sourced {
  return { value: w.title, sourceUrl: w.url, sourceLabel: w.sourceLabel, fetchedAt: null, confidence: w.confidence, note: null, observedAt: w.date };
}

/** Apollo stores revenue as a bare dollar figure ("16416000"). Show it as a band. */
export function formatRevenue(raw: string): string {
  const n = Number(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0 || !/^\s*\$?[\d,.]+\s*$/.test(raw)) return raw;
  if (n >= 1e9) return `about $${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `about $${Math.round(n / 1e6)}M`;
  return `about $${Math.round(n / 1e3)}K`;
}

export function getCompanyProfile(companyId: number): CompanyProfile | null {
  const company = db().prepare("SELECT * FROM companies WHERE id = ?").get(companyId) as CompanyRow | undefined;
  if (!company) return null;
  const facts = db()
    .prepare(
      `SELECT field, value, source_url, source_label, confidence, match_basis, note, observed_at, fetched_at
       FROM profile_facts WHERE entity = 'company' AND entity_id = ? ORDER BY id`
    )
    .all(companyId) as FactRow[];
  const signals = db()
    .prepare("SELECT id, kind, title, url, observed_at FROM signals WHERE company_id = ? ORDER BY observed_at DESC, id DESC")
    .all(companyId) as SignalRow[];
  return buildProfile(company, facts, signals);
}

/** Site name vs CRM name. Apollo masks surnames ("Ma***d"); a mask matches on its visible ends. */
export function samePerson(siteName: string, first: string | null, last: string | null): boolean {
  const parts = siteName.toLowerCase().trim().split(/\s+/);
  if (!first || !last || parts[0] !== first.toLowerCase().trim()) return false;
  const ln = last.toLowerCase().trim();
  const siteLast = parts[parts.length - 1];
  if (ln.includes("*")) {
    const head = ln.split("*")[0];
    const tail = ln.split("*").pop() ?? "";
    return siteLast.startsWith(head) && siteLast.endsWith(tail) && siteLast.length >= head.length + tail.length;
  }
  return siteLast === ln;
}

export type ContactOwnerView = {
  isPrincipal: boolean; // the company site names this contact as its principal
  siteMatch: Leader | null; // how the company site lists this contact, if it does
  principal: { name: Sourced; title: Sourced | null } | null; // who the site names, when it is someone else
};

export function contactOwnerView(
  contact: { first_name: string | null; last_name: string | null },
  profile: CompanyProfile
): ContactOwnerView {
  const siteMatch = profile.leaders.find((l) => samePerson(l.name, contact.first_name, contact.last_name)) ?? null;
  const ownerName = profile.owner.name;
  const isPrincipal = Boolean(ownerName && samePerson(ownerName.value, contact.first_name, contact.last_name));
  return {
    isPrincipal,
    siteMatch,
    principal: ownerName && !isPrincipal ? { name: ownerName, title: profile.owner.title } : null,
  };
}
