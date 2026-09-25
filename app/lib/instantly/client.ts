// Server-only Instantly API v2 client. Every endpoint below was read from the
// live docs (developer.instantly.ai, 2026-09-25) and is cited next to its call.
// Auth: `Authorization: Bearer <INSTANTLY_API_KEY>` (securitySchemes.ApiKeyAuth
// is `type: http, scheme: bearer` in https://api.instantly.ai/openapi/api_v2.json).
//
// The key is read from process.env at call time only. Never log it, echo it to
// a client response, or persist it. Import this module from server code only.
//
// This client never sends email. The only write it performs is adding a lead
// to a campaign (createLead), which is called ONLY by InstantlyProvider after
// the send gate passes. Instantly then sends on its own schedule.

const BASE_URL = "https://api.instantly.ai/api/v2";
const TIMEOUT_MS = 15_000;

export class InstantlyNotConfigured extends Error {
  constructor() {
    super("Instantly is not configured: INSTANTLY_API_KEY is not set.");
    this.name = "InstantlyNotConfigured";
  }
}

export class InstantlyRequestError extends Error {
  status: number;
  constructor(status: number, detail?: string) {
    super(detail || `Instantly request failed: HTTP ${status}`);
    this.name = "InstantlyRequestError";
    this.status = status;
  }
}

export function isInstantlyConfigured(): boolean {
  return !!process.env.INSTANTLY_API_KEY;
}

// ---------------------------------------------------------------- shared-workspace isolation
//
// This Instantly workspace (and its API key) may be SHARED with another
// tenant's cold-email campaigns and sending domains (for example an agency's). Everything below exists so
// this harness can never pull another tenant's mailboxes, replies, or leads into
// the firm's CRM. Fail closed: an empty/unset allowlist means zero accounts and
// zero replies are ever imported, never "import everything."

/** Case-insensitive exact-domain match, never a substring match. */
export function getAllowedDomains(): string[] {
  const raw = process.env.INSTANTLY_ALLOWED_DOMAINS || "";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

export function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase() : null;
}

/** Exact match only: "mail.yourfirm-mail.example" is NOT allowed by "yourfirm-mail.example". */
export function isAllowedDomain(address: string, allowedDomains: string[]): boolean {
  const domain = domainOfAddress(address);
  if (!domain) return false;
  return allowedDomains.includes(domain);
}

export function getAllowedCampaignIds(): string[] {
  const raw = process.env.INSTANTLY_CAMPAIGN_ID || "";
  return raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

async function call<T>(method: "GET" | "POST", pathAndQuery: string, body?: unknown): Promise<T> {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) throw new InstantlyNotConfigured();
  const res = await fetch(`${BASE_URL}${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    if (res.status === 401) throw new InstantlyRequestError(401, "Instantly rejected the configured API key.");
    if (res.status === 429) throw new InstantlyRequestError(429, "Instantly is rate limiting this workspace right now.");
    throw new InstantlyRequestError(res.status);
  }
  return (await res.json().catch(() => ({}))) as T;
}

// ---------------------------------------------------------------- leads

export type CreateLeadInput = {
  campaignId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  customVariables: Record<string, string>;
};

/**
 * POST /api/v2/leads ("Create lead").
 * https://developer.instantly.ai/api-reference/lead/create-lead
 * Body fields used: campaign (uuid), email, first_name, last_name,
 * company_name, custom_variables (object of scalar values), and
 * skip_if_in_campaign so a lead already in the campaign is never re-added
 * (and so never re-emailed by a second push). Response: the Lead (has `id`).
 */
export async function createLead(input: CreateLeadInput): Promise<{ id?: string }> {
  return call<{ id?: string }>("POST", "/leads", {
    campaign: input.campaignId,
    email: input.email,
    first_name: input.firstName ?? null,
    last_name: input.lastName ?? null,
    company_name: input.companyName ?? null,
    skip_if_in_campaign: true,
    custom_variables: input.customVariables,
  });
}

/**
 * POST /api/v2/leads/update-interest-status ("Update the interest status of a lead").
 * https://developer.instantly.ai/api-reference/lead/update-the-interest-status-of-a-lead
 * Body: lead_email, interest_value (1 Interested, 0 Out of Office, -1 Not
 * Interested, ... see lt_interest_status in the Create lead schema), campaign_id.
 * Returns 202 (background job). NOT called automatically anywhere: per the docs
 * an explicit interest update can complete campaign leads and trigger Instantly
 * automations, so it stays a deliberate, human-triggered action.
 */
export async function updateLeadInterest(leadEmail: string, interestValue: number | null, campaignId?: string) {
  return call<{ message?: string }>("POST", "/leads/update-interest-status", {
    lead_email: leadEmail,
    interest_value: interestValue,
    ...(campaignId ? { campaign_id: campaignId } : {}),
  });
}

// ---------------------------------------------------------------- campaigns

export type InstantlyCampaign = {
  id: string;
  name: string;
  status: number; // 0 Draft, 1 Active, 2 Paused, 3 Completed, 4 Running Subsequences, -99/-1/-2 problem states
  stop_on_reply?: boolean | null;
  stop_on_auto_reply?: boolean | null;
  email_list?: string[] | null;
};

/**
 * GET /api/v2/campaigns/{id} ("Get campaign").
 * https://developer.instantly.ai/api-reference/campaign/get-campaign
 */
export async function getCampaign(id: string): Promise<InstantlyCampaign> {
  return call<InstantlyCampaign>("GET", `/campaigns/${encodeURIComponent(id)}`);
}

/**
 * GET /api/v2/campaigns ("List campaign"). Query: limit (1-100), starting_after.
 * https://developer.instantly.ai/api-reference/campaign/list-campaign
 */
export async function listCampaigns(limit = 100): Promise<{ items: InstantlyCampaign[]; next_starting_after?: string }> {
  return call("GET", `/campaigns?limit=${limit}`);
}

// ---------------------------------------------------------------- emails (Unibox)

export type InstantlyEmail = {
  id: string;
  timestamp_created: string; // when Instantly stored it (used as the poll cursor)
  timestamp_email?: string | null; // as reported by the mail server
  message_id?: string | null;
  subject?: string | null;
  from_address_email?: string | null;
  to_address_email_list?: string | null;
  body?: { text?: string | null; html?: string | null } | null;
  campaign_id?: string | null;
  lead?: string | null; // the lead's email address
  lead_id?: string | null;
  eaccount?: string | null; // the sending mailbox the thread belongs to
  ue_type?: number | null; // 1 sent from campaign, 2 received, 3 sent, 4 scheduled
  is_auto_reply?: number | null; // 0 false, 1 true
  i_status?: number | null;
  thread_id?: string | null;
  content_preview?: string | null;
};

/**
 * GET /api/v2/emails ("List email", the Unibox list).
 * https://developer.instantly.ai/api-reference/email/list-email
 * Query used: email_type=received, min_timestamp_created (ISO, "created after"),
 * sort_order=asc (oldest first, so the cursor can advance page by page),
 * limit (1-100), starting_after (= next_starting_after of the previous page),
 * and campaign_id when one is configured.
 * Rate limit per the docs: 20 requests per minute for this endpoint.
 */
export async function listReceivedEmails(opts: {
  since?: string | null;
  campaignId?: string | null;
  startingAfter?: string | null;
  limit?: number;
}): Promise<{ items: InstantlyEmail[]; next_starting_after?: string | null }> {
  const q = new URLSearchParams();
  q.set("email_type", "received");
  q.set("sort_order", "asc");
  q.set("limit", String(opts.limit ?? 100));
  if (opts.since) q.set("min_timestamp_created", opts.since);
  if (opts.campaignId) q.set("campaign_id", opts.campaignId);
  if (opts.startingAfter) q.set("starting_after", opts.startingAfter);
  return call("GET", `/emails?${q.toString()}`);
}

// ---------------------------------------------------------------- accounts (sending mailboxes)

export type InstantlyAccount = {
  email: string;
  daily_limit?: number | null;
  status?: number | null; // 1 Active, 2 Paused, 3 maintenance, -1/-2/-3 errors
  timestamp_warmup_start?: string | null;
  warmup_status?: number | null;
};

/**
 * GET /api/v2/accounts ("List account"). Query: limit (1-100), starting_after.
 * https://developer.instantly.ai/api-reference/account/list-account
 */
export async function listAccounts(): Promise<InstantlyAccount[]> {
  const out: InstantlyAccount[] = [];
  let after: string | null | undefined = null;
  for (let page = 0; page < 10; page++) {
    const q: string = after ? `&starting_after=${encodeURIComponent(after)}` : "";
    const res: { items?: InstantlyAccount[]; next_starting_after?: string | null } = await call(
      "GET",
      `/accounts?limit=100${q}`
    );
    out.push(...(res.items ?? []));
    after = res.next_starting_after;
    if (!after || !res.items?.length) break;
  }
  return out;
}
