// Poll (not webhook) for replies received through Instantly. Deal Desk runs on
// localhost, so Instantly cannot reach it; instead the owner presses "Check
// Instantly for replies", or scripts/poll-instantly-replies.mjs runs it.
//
// Reads GET https://api.instantly.ai/api/v2/emails (Unibox "List email",
// https://developer.instantly.ai/api-reference/email/list-email) with
// email_type=received and min_timestamp_created = the stored cursor, oldest
// first, and hands each message to ingestReply(), which does every
// downstream effect idempotently (inbound_replies.provider_id is UNIQUE).
//
// SHARED WORKSPACE ISOLATION: this Instantly workspace may also carry another
// tenant's campaigns and mailboxes, in the same Unibox this
// endpoint reads from. Per the live doc quoted below, GET /api/v2/emails
// accepts a `campaign_id` query param, so the request is scoped server-side
// to INSTANTLY_CAMPAIGN_ID (which may be a comma list; the request is made
// once per campaign id). That alone is not trusted, though: every email
// returned is re-checked client-side against the campaign id list AND
// against INSTANTLY_ALLOWED_DOMAINS (the mailbox it was sent to/from must be
// one of the firm's own sending domains). Either check failing drops the
// email before it is ever stored or logged — only a count survives. If
// either INSTANTLY_CAMPAIGN_ID or INSTANTLY_ALLOWED_DOMAINS is unset, the
// poll refuses outright and touches nothing.
import { db, audit } from "../db";
import { ingestReply } from "./sync";
import {
  isInstantlyConfigured,
  listReceivedEmails,
  getAllowedDomains,
  getAllowedCampaignIds,
  isAllowedDomain,
  InstantlyNotConfigured,
  InstantlyRequestError,
  type InstantlyEmail,
} from "../instantly/client";

export const INSTANTLY_CURSOR = "instantly.replies";
const MAX_PAGES = 5; // the emails endpoint allows 20 requests/minute; stay well under
const DEFAULT_LOOKBACK_DAYS = 30;

export function getCursor(name: string): string | null {
  const row = db().prepare(`SELECT value FROM sync_cursors WHERE name = ?`).get(name) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setCursor(name: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO sync_cursors (name, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(name, value);
}

/**
 * The replier's own words, without the quoted thread below them. Used for
 * classification only (the full text is always stored), so a quoted copy of
 * our own footer ("...unsubscribe...") can't make a real reply look like an
 * unsubscribe request.
 */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (/^On .+wrote:$/i.test(t) || /^-+\s*Original Message\s*-+$/i.test(t) || (/^From: .+/.test(t) && out.length > 0)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export type InstantlyPollResult = {
  ok: boolean;
  fetched: number;
  inserted: number;
  replies: number;
  autoReplies: number;
  dealsOpened: number;
  cursor: string | null;
  error?: string;
};

function ingestOne(m: InstantlyEmail) {
  const fromEmail = (m.from_address_email || m.lead || "").trim();
  if (!fromEmail) return null;
  if (m.ue_type != null && m.ue_type !== 2) return null; // 2 = Received; anything else is ours
  const fullText = m.body?.text || (m.body?.html ? htmlToText(m.body.html) : "") || m.content_preview || "";
  const ownWords = stripQuoted(fullText) || m.content_preview || "";
  return ingestReply({
    providerId: `instantly:${m.id}`,
    fromEmail,
    subject: m.subject ?? null,
    snippet: ownWords.slice(0, 500),
    body: fullText || null,
    receivedAt: m.timestamp_email || m.timestamp_created,
    isAutoReply: m.is_auto_reply === 1,
    provider: "instantly",
    providerLabel: "Instantly",
    threadId: m.thread_id ?? null,
    toEmail: m.eaccount ?? null,
    openDealOnReply: true,
  });
}

export async function pollInstantlyReplies(opts: { actorUserId?: number | null; now?: Date } = {}): Promise<InstantlyPollResult> {
  const base = { fetched: 0, inserted: 0, replies: 0, autoReplies: 0, dealsOpened: 0 };
  if (!isInstantlyConfigured()) {
    return { ok: false, ...base, cursor: getCursor(INSTANTLY_CURSOR), error: "Instantly is not configured." };
  }

  const allowedCampaignIds = getAllowedCampaignIds();
  const allowedDomains = getAllowedDomains();
  if (allowedCampaignIds.length === 0 || allowedDomains.length === 0) {
    return {
      ok: false,
      ...base,
      cursor: getCursor(INSTANTLY_CURSOR),
      error:
        "Not configured: INSTANTLY_CAMPAIGN_ID and INSTANTLY_ALLOWED_DOMAINS must both be set before replies can be polled (the workspace may be shared with another tenant).",
    };
  }

  const startCursor = getCursor(INSTANTLY_CURSOR);
  const since =
    startCursor ?? new Date((opts.now ?? new Date()).getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const tally = { ...base };
  let maxSeen = startCursor;
  let error: string | undefined;

  try {
    // One request per allowed campaign id: the docs give campaign_id a single
    // value, not a list, so a comma list in INSTANTLY_CAMPAIGN_ID is fanned
    // out here rather than trusted to the server to parse.
    for (const campaignId of allowedCampaignIds) {
      let after: string | null | undefined = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await listReceivedEmails({ since, campaignId, startingAfter: after, limit: 100 });
        const items = res.items ?? [];
        tally.fetched += items.length;
        for (const m of items) {
          // Defense in depth: never trust the server-side campaign_id filter
          // alone. Drop anything whose own campaign_id field isn't one of
          // ours, and anything whose firm-side mailbox (the account it was
          // sent to/from) isn't an allowed domain. A dropped email is never
          // stored and never logged with its content -- only counts survive.
          if (!m.campaign_id || !allowedCampaignIds.includes(m.campaign_id)) continue;
          const mailbox = m.eaccount || "";
          if (!isAllowedDomain(mailbox, allowedDomains)) continue;
          const out = ingestOne(m);
          if (out?.inserted) {
            tally.inserted += 1;
            if (out.kind === "reply") tally.replies += 1;
            if (out.kind === "auto-reply") tally.autoReplies += 1;
            if (out.dealOpened) tally.dealsOpened += 1;
          }
          if (m.timestamp_created && (!maxSeen || m.timestamp_created > maxSeen)) maxSeen = m.timestamp_created;
        }
        after = res.next_starting_after;
        if (!after || items.length === 0) break;
      }
    }
  } catch (err) {
    if (err instanceof InstantlyNotConfigured) error = "Instantly is not configured.";
    else if (err instanceof InstantlyRequestError) error = err.message;
    else error = "Unexpected error contacting Instantly.";
  }

  // Advance past everything processed, even on a mid-run failure; re-reading
  // a message later is harmless because ingest is idempotent.
  if (maxSeen && maxSeen !== startCursor) setCursor(INSTANTLY_CURSOR, maxSeen);

  audit({
    actorUserId: opts.actorUserId ?? null,
    actorLabel: opts.actorUserId ? undefined : "instantly-poll",
    action: error ? "replies.instantly.poll.error" : "replies.instantly.poll",
    entity: "inbound_replies",
    detail: { ...tally, since, cursor: maxSeen, error },
  });

  return { ok: !error, ...tally, cursor: maxSeen, ...(error ? { error } : {}) };
}
