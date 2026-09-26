// Server-only Microsoft Graph reader for Outlook auto-capture. READ ONLY: it
// fetches mail and calendar METADATA for one mailbox and never sends, moves,
// flags or deletes anything. Auth is the OAuth 2.0 client-credentials flow
// (application permissions Mail.Read + Calendars.Read, scoped to one mailbox
// by an Exchange ApplicationAccessPolicy; see docs/OUTLOOK-CAPTURE.md).
//
// fetch is injectable so tests never touch the real Microsoft endpoints.
// Secrets are passed in from config.ts and never logged or returned.
import type { GraphConfig } from "./config";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const LOGIN_BASE = "https://login.microsoftonline.com";
const SCOPE = "https://graph.microsoft.com/.default";
export const MAX_PAGES = 10; // hard cap per run, 50 items a page
const PAGE_SIZE = 50;
const TIMEOUT_MS = 15_000;

export class GraphRequestError extends Error {
  status: number;
  constructor(status: number, what: string) {
    super(`Microsoft Graph ${what} failed: HTTP ${status}`);
    this.name = "GraphRequestError";
    this.status = status;
  }
}

export type GraphAddress = { emailAddress?: { address?: string | null; name?: string | null } | null };

export type GraphMessage = {
  id: string;
  internetMessageId?: string | null;
  subject?: string | null;
  from?: GraphAddress | null;
  toRecipients?: GraphAddress[] | null;
  ccRecipients?: GraphAddress[] | null;
  sentDateTime?: string | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
  conversationId?: string | null;
};

export type GraphEvent = {
  id: string;
  iCalUId?: string | null;
  subject?: string | null;
  start?: { dateTime?: string | null; timeZone?: string | null } | null;
  end?: { dateTime?: string | null; timeZone?: string | null } | null;
  organizer?: GraphAddress | null;
  attendees?: GraphAddress[] | null;
  isCancelled?: boolean | null;
};

const MESSAGE_FIELDS = [
  "id",
  "internetMessageId",
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "sentDateTime",
  "receivedDateTime",
  "bodyPreview",
  "conversationId",
].join(",");

const EVENT_FIELDS = ["id", "iCalUId", "subject", "start", "end", "organizer", "attendees", "isCancelled"].join(",");

async function timed(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Client-credentials token. The secret goes only to login.microsoftonline.com. */
export async function getToken(cfg: GraphConfig, fetchImpl: FetchLike): Promise<string> {
  const url = `${LOGIN_BASE}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: SCOPE,
    grant_type: "client_credentials",
  });
  const res = await timed(fetchImpl, url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new GraphRequestError(res.status, "sign-in");
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new GraphRequestError(res.status, "sign-in");
  return json.access_token;
}

/** Follows @odata.nextLink up to MAX_PAGES. Only ever follows links on the Graph host. */
async function pages<T>(fetchImpl: FetchLike, token: string, firstUrl: string, what: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await timed(fetchImpl, url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
    });
    if (!res.ok) throw new GraphRequestError(res.status, what);
    const json = (await res.json()) as { value?: T[]; "@odata.nextLink"?: string };
    if (Array.isArray(json.value)) out.push(...json.value);
    const next = json["@odata.nextLink"];
    url = typeof next === "string" && next.startsWith(`${GRAPH_BASE}/`) ? next : null;
  }
  return out;
}

/** Messages in every folder (inbox and sent) received at or after `sinceIso`, oldest first. */
export function listMessages(cfg: GraphConfig, token: string, sinceIso: string, fetchImpl: FetchLike) {
  const q = new URLSearchParams({
    $select: MESSAGE_FIELDS,
    $filter: `receivedDateTime ge ${sinceIso}`,
    $orderby: "receivedDateTime asc",
    $top: String(PAGE_SIZE),
  });
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(cfg.mailbox)}/messages?${q.toString()}`;
  return pages<GraphMessage>(fetchImpl, token, url, "mail read");
}

/** Calendar occurrences (recurring meetings expanded) between two instants. */
export function listEvents(cfg: GraphConfig, token: string, startIso: string, endIso: string, fetchImpl: FetchLike) {
  const q = new URLSearchParams({
    startDateTime: startIso,
    endDateTime: endIso,
    $select: EVENT_FIELDS,
    $orderby: "start/dateTime asc",
    $top: String(PAGE_SIZE),
  });
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(cfg.mailbox)}/calendarView?${q.toString()}`;
  return pages<GraphEvent>(fetchImpl, token, url, "calendar read");
}
