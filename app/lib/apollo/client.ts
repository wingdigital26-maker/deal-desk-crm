// Server-only Apollo REST client. The API key is read ONLY from
// process.env.APOLLO_API_KEY at call time. Never hardcode it, log it, echo it
// to a client response, or persist it anywhere. Some keys begin with a dash;
// never trim, sanitize, or otherwise "clean" the value beyond reading it raw.
// This module touches process.env and must only be imported from server
// code (API routes, server components) -- never from a client component.

const BASE_URL = "https://api.apollo.io/api/v1";
const TIMEOUT_MS = 15_000;

export class ApolloNotConfigured extends Error {
  constructor() {
    super("Apollo is not configured: APOLLO_API_KEY is not set.");
    this.name = "ApolloNotConfigured";
  }
}

export class ApolloAuthError extends Error {
  constructor(detail?: string) {
    super(detail || "Apollo rejected the API key.");
    this.name = "ApolloAuthError";
  }
}

export class ApolloRateLimited extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Apollo rate limited the request. Retry after ${retryAfterMs}ms.`);
    this.name = "ApolloRateLimited";
    this.retryAfterMs = retryAfterMs;
  }
}

export class ApolloRequestError extends Error {
  status: number;
  constructor(status: number, detail?: string) {
    super(detail || `Apollo request failed with status ${status}.`);
    this.name = "ApolloRequestError";
    this.status = status;
  }
}

export function isConfigured(): boolean {
  return typeof process.env.APOLLO_API_KEY === "string" && process.env.APOLLO_API_KEY.length > 0;
}

function apiKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new ApolloNotConfigured();
  return key;
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 2000;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 2000;
}

async function request<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: Record<string, unknown> },
  attempt = 0
): Promise<T> {
  const key = apiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Api-Key": key,
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApolloRequestError(0, "Apollo request timed out.");
    }
    throw new ApolloRequestError(0, "Apollo request failed to send.");
  }
  clearTimeout(timer);

  if (res.status === 401 || res.status === 403) {
    throw new ApolloAuthError();
  }

  if (res.status === 429) {
    if (attempt >= 1) {
      throw new ApolloRateLimited(parseRetryAfter(res.headers.get("Retry-After")));
    }
    const waitMs = parseRetryAfter(res.headers.get("Retry-After"));
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 15_000)));
    return request<T>(path, init, attempt + 1);
  }

  if (!res.ok) {
    let detail: string | undefined;
    try {
      const parsed = (await res.json()) as { error?: string; message?: string };
      detail = parsed.error || parsed.message;
    } catch {
      // response body was not JSON; fall through with no detail
    }
    throw new ApolloRequestError(res.status, detail);
  }

  try {
    return (await res.json()) as T;
  } catch {
    // Some endpoints (rare) may return an empty body on success.
    return {} as T;
  }
}

// ---- Defensive shape helpers -------------------------------------------
// Apollo's response fields are not contractually stable. Every getter below
// tolerates unknown/missing fields rather than throwing.

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export type ApolloPerson = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  linkedinUrl: string | null;
  organizationName: string | null;
  organizationDomain: string | null;
  city: string | null;
  state: string | null;
  raw: unknown;
};

export type ApolloOrganization = {
  id: string;
  name: string | null;
  domain: string | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  estimatedEmployees: number | null;
  raw: unknown;
};

function mapPerson(p: Record<string, unknown>): ApolloPerson {
  const org = (p.organization as Record<string, unknown>) || {};
  return {
    id: String(p.id ?? ""),
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    name: str(p.name),
    title: str(p.title),
    email: str(p.email),
    emailStatus: str(p.email_status),
    linkedinUrl: str(p.linkedin_url),
    organizationName: str(org.name),
    organizationDomain: str(org.primary_domain ?? org.website_url ?? org.domain),
    city: str(p.city),
    state: str(p.state),
    raw: p,
  };
}

function mapOrganization(o: Record<string, unknown>): ApolloOrganization {
  return {
    id: String(o.id ?? ""),
    name: str(o.name),
    domain: str(o.primary_domain ?? o.website_url ?? o.domain),
    industry: str(o.industry),
    city: str(o.city),
    state: str(o.state),
    estimatedEmployees: num(o.estimated_num_employees),
    raw: o,
  };
}

export type PeopleSearchFilters = {
  personTitles?: string[];
  personLocations?: string[];
  organizationLocations?: string[];
  organizationNumEmployeesRanges?: string[];
  qKeywords?: string;
  page?: number;
  perPage?: number;
};

export type CompanySearchFilters = {
  organizationLocations?: string[];
  organizationNumEmployeesRanges?: string[];
  qKeywords?: string;
  page?: number;
  perPage?: number;
};

export type SearchResult<T> = {
  results: T[];
  page: number;
  perPage: number;
  totalEntries: number | null;
};

export async function searchPeople(filters: PeopleSearchFilters): Promise<SearchResult<ApolloPerson>> {
  const body: Record<string, unknown> = {
    person_titles: filters.personTitles,
    person_locations: filters.personLocations,
    organization_locations: filters.organizationLocations,
    organization_num_employees_ranges: filters.organizationNumEmployeesRanges,
    q_keywords: filters.qKeywords,
    page: filters.page ?? 1,
    per_page: filters.perPage ?? 25,
  };
  const data = await request<Record<string, unknown>>("/mixed_people/api_search", {
    method: "POST",
    body,
  });
  const people = Array.isArray(data.people) ? (data.people as Record<string, unknown>[]) : [];
  const pagination = (data.pagination as Record<string, unknown>) || {};
  return {
    results: people.map(mapPerson),
    page: num(pagination.page) ?? filters.page ?? 1,
    perPage: num(pagination.per_page) ?? filters.perPage ?? 25,
    totalEntries: num(pagination.total_entries),
  };
}

export async function searchCompanies(filters: CompanySearchFilters): Promise<SearchResult<ApolloOrganization>> {
  const body: Record<string, unknown> = {
    organization_locations: filters.organizationLocations,
    organization_num_employees_ranges: filters.organizationNumEmployeesRanges,
    q_keywords: filters.qKeywords,
    page: filters.page ?? 1,
    per_page: filters.perPage ?? 25,
  };
  const data = await request<Record<string, unknown>>("/mixed_companies/search", {
    method: "POST",
    body,
  });
  const orgs = Array.isArray(data.organizations)
    ? (data.organizations as Record<string, unknown>[])
    : Array.isArray(data.accounts)
      ? (data.accounts as Record<string, unknown>[])
      : [];
  const pagination = (data.pagination as Record<string, unknown>) || {};
  return {
    results: orgs.map(mapOrganization),
    page: num(pagination.page) ?? filters.page ?? 1,
    perPage: num(pagination.per_page) ?? filters.perPage ?? 25,
    totalEntries: num(pagination.total_entries),
  };
}

export type EnrichPersonInput =
  | { confirmSpend: true; id: string }
  | { confirmSpend: true; email: string }
  | { confirmSpend: true; firstName: string; lastName: string; domain: string };

// SPENDS CREDITS. Requires an explicit confirmSpend: true so nothing calls
// this by accident while building or wiring up the UI.
export async function enrichPerson(input: EnrichPersonInput): Promise<ApolloPerson | null> {
  if (!input.confirmSpend) {
    throw new Error("enrichPerson spends Apollo credits and requires confirmSpend: true.");
  }
  const body: Record<string, unknown> = {};
  if ("id" in input) body.id = input.id;
  if ("email" in input) body.email = input.email;
  if ("firstName" in input) {
    body.first_name = input.firstName;
    body.last_name = input.lastName;
    body.domain = input.domain;
  }
  const data = await request<Record<string, unknown>>("/people/match", { method: "POST", body });
  const person = data.person as Record<string, unknown> | undefined;
  return person ? mapPerson(person) : null;
}

export type ApolloInboundMessage = {
  id: string;
  fromEmail: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string | null;
  headers: Record<string, string> | null;
  raw: unknown;
};

function mapInboundMessage(m: Record<string, unknown>): ApolloInboundMessage {
  const fromObj = (m.from as Record<string, unknown>) || {};
  const headersRaw = m.headers;
  return {
    id: String(m.id ?? m.message_id ?? ""),
    fromEmail: str(m.from_email) ?? str(fromObj.email),
    subject: str(m.subject),
    snippet: str(m.snippet ?? m.body_text ?? m.preview),
    receivedAt: str(m.received_at ?? m.replied_at ?? m.created_at),
    headers: headersRaw && typeof headersRaw === "object" ? (headersRaw as Record<string, string>) : null,
    raw: m,
  };
}

// Pulls recent inbound emailer messages (replies, bounces, auto-replies) so
// they can be classified and read into inbound_replies. Apollo's public docs
// do not pin down one stable endpoint name for this, so the response is
// parsed defensively against several plausible field names; if the shape
// this account returns differs, results will just come back empty rather
// than throwing.
export async function searchEmailerMessages(filters: {
  page?: number;
  perPage?: number;
}): Promise<SearchResult<ApolloInboundMessage>> {
  const body: Record<string, unknown> = {
    page: filters.page ?? 1,
    per_page: filters.perPage ?? 100,
  };
  const data = await request<Record<string, unknown>>("/emailer_messages/search", { method: "POST", body });
  const messages = Array.isArray(data.emailer_messages)
    ? (data.emailer_messages as Record<string, unknown>[])
    : Array.isArray(data.messages)
      ? (data.messages as Record<string, unknown>[])
      : [];
  const pagination = (data.pagination as Record<string, unknown>) || {};
  return {
    results: messages.map(mapInboundMessage),
    page: num(pagination.page) ?? filters.page ?? 1,
    perPage: num(pagination.per_page) ?? filters.perPage ?? 100,
    totalEntries: num(pagination.total_entries),
  };
}

export type ApolloEmailAccount = {
  id: string;
  email: string | null;
  status: string | null;
  raw: unknown;
};

export async function listEmailAccounts(): Promise<ApolloEmailAccount[]> {
  const data = await request<Record<string, unknown>>("/email_accounts", { method: "GET" });
  const accounts = Array.isArray(data.email_accounts)
    ? (data.email_accounts as Record<string, unknown>[])
    : [];
  return accounts.map((a) => ({
    id: String(a.id ?? ""),
    email: str(a.email),
    status: str(a.status),
    raw: a,
  }));
}

export type ApolloSequence = {
  id: string;
  name: string | null;
  numContacts: number | null;
  raw: unknown;
};

export async function listSequences(q?: string): Promise<ApolloSequence[]> {
  const data = await request<Record<string, unknown>>("/emailer_campaigns/search", {
    method: "POST",
    body: q ? { q_keywords: q } : {},
  });
  const campaigns = Array.isArray(data.emailer_campaigns)
    ? (data.emailer_campaigns as Record<string, unknown>[])
    : [];
  return campaigns.map((c) => ({
    id: String(c.id ?? ""),
    name: str(c.name),
    numContacts: num(c.num_contacts),
    raw: c,
  }));
}

export type ApolloCreditUsage = {
  creditsUsed: number | null;
  creditsRemaining: number | null;
  raw: unknown;
};

// Apollo does not document a single stable "credits remaining" REST field;
// this defensively parses whatever a usage/credit endpoint returns and
// tolerates any shape, including one that does not exist for this account's
// plan. Callers should treat a null result as "not available" rather than
// as an error.
export async function getCreditUsage(): Promise<ApolloCreditUsage | null> {
  try {
    const data = await request<Record<string, unknown>>("/usage_stats/credit_usage_stats", { method: "GET" });
    const remaining = num(data.credits_remaining ?? data.remaining ?? data.available_credits ?? data.credits_available);
    const used = num(data.credits_used ?? data.used ?? data.credits_consumed);
    if (remaining === null && used === null) return null;
    return { creditsUsed: used, creditsRemaining: remaining, raw: data };
  } catch {
    return null;
  }
}

// Sending belongs to the send-pipe lane and its approval gate. This method
// exists on the client for that lane to call later; no API route in this
// round exposes it.
export async function addContactsToSequence(
  sequenceId: string,
  contactIds: string[],
  options?: { emailAccountId?: string }
): Promise<unknown> {
  return request(`/emailer_campaigns/${encodeURIComponent(sequenceId)}/add_contact_ids`, {
    method: "POST",
    body: {
      contact_ids: contactIds,
      emailer_campaign_id: sequenceId,
      send_email_from_email_account_id: options?.emailAccountId,
    },
  });
}
