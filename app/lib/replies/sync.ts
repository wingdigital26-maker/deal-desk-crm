// Reads inbound email activity (replies, bounces, unsubscribes, auto-replies)
// back into the CRM. classifyMessage and ingestReply are provider-agnostic:
// ingestReply performs every downstream effect and is the function a future
// webhook or a different mail system can call directly. syncReplies is the
// Apollo-specific puller that turns Apollo's messages into ingestReply calls.
import { db, audit } from "../db";
import { firm } from "../../../firm.config";
import {
  isConfigured,
  searchEmailerMessages,
  ApolloAuthError,
  ApolloRateLimited,
  ApolloRequestError,
  ApolloNotConfigured,
} from "../apollo/client";

export type ReplyKind = "reply" | "bounce" | "unsubscribe" | "auto-reply";

export type ClassifyInput = {
  fromEmail: string;
  subject?: string | null;
  snippet?: string | null;
  headers?: Record<string, string> | null;
};

const BOUNCE_PHRASES = ["delivery status notification", "undeliverable", "failure notice", "returned mail"];
const UNSUB_PHRASES = ["unsubscribe", "remove me"];
const AUTO_REPLY_PHRASES = ["out of office", "automatic reply", "auto-reply", "autoreply"];

// Order matters: check the more specific signals (bounce, unsubscribe,
// auto-reply) before falling back to "reply", since a genuine reply is the
// default outcome when nothing else matches.
export function classifyMessage(input: ClassifyInput): ReplyKind {
  const from = (input.fromEmail || "").toLowerCase();
  const text = `${input.subject || ""} ${input.snippet || ""}`.toLowerCase();
  const headers = input.headers || {};
  const autoSubmitted = (headers["auto-submitted"] || headers["Auto-Submitted"] || "").toLowerCase();

  if (from.includes("mailer-daemon") || BOUNCE_PHRASES.some((p) => text.includes(p))) {
    return "bounce";
  }
  if (UNSUB_PHRASES.some((p) => text.includes(p))) {
    return "unsubscribe";
  }
  if (AUTO_REPLY_PHRASES.some((p) => text.includes(p)) || (autoSubmitted && autoSubmitted !== "no")) {
    return "auto-reply";
  }
  return "reply";
}

function contactNameFor(contactId: number): string {
  const c = db().prepare(`SELECT first_name, last_name FROM contacts WHERE id = ?`).get(contactId) as
    | { first_name: string | null; last_name: string | null }
    | undefined;
  if (!c) return "this contact";
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
  return name || "this contact";
}

function companyIdFor(contactId: number): number | null {
  const c = db().prepare(`SELECT company_id FROM contacts WHERE id = ?`).get(contactId) as
    | { company_id: number | null }
    | undefined;
  return c?.company_id ?? null;
}

function openDealIdFor(companyId: number): number | null {
  const d = db()
    .prepare(
      `SELECT id FROM deals WHERE company_id = ? AND stage NOT IN ('Closed','Passed') ORDER BY updated_at DESC LIMIT 1`
    )
    .get(companyId) as { id: number } | undefined;
  return d?.id ?? null;
}

// Opens a first-stage deal for a company that answered outreach and has no
// open deal yet. Returns the new deal id.
function openReplyDeal(companyId: number, contactId: number, replyId: number): number {
  const company = db().prepare(`SELECT name FROM companies WHERE id = ?`).get(companyId) as { name: string } | undefined;
  const title = `${company?.name ?? "Company"}: replied to outreach`;
  const stage = firm.dealStages[0];
  const info = db()
    .prepare(`INSERT INTO deals (company_id, primary_contact_id, title, stage) VALUES (?, ?, ?, ?)`)
    .run(companyId, contactId, title, stage);
  const dealId = Number(info.lastInsertRowid);
  audit({
    action: "deal.create",
    entity: "deal",
    entityId: dealId,
    detail: { source: "reply", replyId, companyId, contactId, stage, title },
  });
  return dealId;
}

// Cancels every queued/held message to a contact (e.g. once they have
// replied, bounced, or asked to be removed, nothing already staged should
// still go out). Returns the number of messages cancelled.
function cancelQueuedFor(contactId: number): number {
  const rows = db()
    .prepare(`SELECT id FROM outbound_messages WHERE contact_id = ? AND status IN ('queued','held')`)
    .all(contactId) as { id: number }[];
  for (const r of rows) {
    db().prepare(`UPDATE outbound_messages SET status = 'cancelled' WHERE id = ?`).run(r.id);
  }
  return rows.length;
}

function findContactByEmail(email: string): number | null {
  const row = db().prepare(`SELECT id FROM contacts WHERE email = ?`).get(email.toLowerCase()) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

function mostRecentSentMessageFor(contactId: number): number | null {
  const row = db()
    .prepare(`SELECT id FROM outbound_messages WHERE contact_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`)
    .get(contactId) as { id: number } | undefined;
  return row?.id ?? null;
}

export type IngestReplyInput = {
  providerId: string;
  fromEmail: string;
  subject?: string | null;
  snippet?: string | null;
  headers?: Record<string, string> | null;
  receivedAt: string;
  // A known outbound_messages.id this is a reply to, if the caller already
  // knows it. When omitted, ingestReply tries to match one by contact email.
  messageId?: number | null;
  // Optional fields used by the Instantly poll (all additive; the Apollo
  // sync and the webhook leave them unset and behave exactly as before).
  body?: string | null; // full text, stored verbatim and never overwritten
  isAutoReply?: boolean; // provider's own auto-reply flag, trusted over heuristics
  provider?: string | null;
  providerLabel?: string | null; // e.g. "Instantly", shown on the timeline
  threadId?: string | null;
  toEmail?: string | null; // the mailbox the reply arrived at
  openDealOnReply?: boolean; // open a first-stage deal if the company has none open
};

export type IngestReplyResult = {
  inserted: boolean;
  kind: ReplyKind | null;
  replyId: number | null;
  contactId: number | null;
  dealOpened?: number | null;
};

// The single provider-agnostic entry point for reading an inbound message
// into the CRM. Idempotent on provider_id: calling it twice with the same id
// inserts nothing the second time and runs no effects again.
export function ingestReply(input: IngestReplyInput): IngestReplyResult {
  const existing = db().prepare(`SELECT id FROM inbound_replies WHERE provider_id = ?`).get(input.providerId) as
    | { id: number }
    | undefined;
  if (existing) {
    return { inserted: false, kind: null, replyId: existing.id, contactId: null };
  }

  const fromEmail = input.fromEmail.toLowerCase().trim();
  let kind = classifyMessage({
    fromEmail,
    subject: input.subject,
    snippet: input.snippet,
    headers: input.headers,
  });
  // A provider-flagged auto-reply is an auto-reply (a bounce still wins).
  if (input.isAutoReply && kind !== "bounce") kind = "auto-reply";

  let matchedMessageId: number | null = input.messageId ?? null;
  let contactId: number | null = null;
  if (matchedMessageId) {
    const row = db().prepare(`SELECT contact_id FROM outbound_messages WHERE id = ?`).get(matchedMessageId) as
      | { contact_id: number }
      | undefined;
    contactId = row?.contact_id ?? null;
  }
  if (!contactId) {
    contactId = findContactByEmail(fromEmail);
    if (contactId && !matchedMessageId) {
      matchedMessageId = mostRecentSentMessageFor(contactId);
    }
  }

  const info = db()
    .prepare(
      `INSERT INTO inbound_replies (provider_id, message_id, contact_id, from_email, subject, snippet, kind, received_at,
                                   body, provider, thread_id, to_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.providerId,
      matchedMessageId,
      contactId,
      fromEmail,
      input.subject ?? null,
      input.snippet ?? null,
      kind,
      input.receivedAt,
      input.body ?? null,
      input.provider ?? null,
      input.threadId ?? null,
      input.toEmail ?? null
    );
  const replyId = Number(info.lastInsertRowid);

  audit({
    action: "reply.ingest",
    entity: "inbound_reply",
    entityId: replyId,
    detail: { kind, contactId, matchedMessageId, providerId: input.providerId },
  });

  let dealOpened: number | null = null;
  if (kind === "reply") {
    if (matchedMessageId) {
      db().prepare(`UPDATE outbound_messages SET replied_at = datetime('now') WHERE id = ?`).run(matchedMessageId);
    }
    if (contactId) {
      const cancelled = cancelQueuedFor(contactId);
      const companyId = companyIdFor(contactId);
      let dealId = companyId ? openDealIdFor(companyId) : null;
      if (input.openDealOnReply && companyId && !dealId) {
        dealId = openReplyDeal(companyId, contactId, replyId);
        dealOpened = dealId;
      }
      const via = input.providerLabel ? ` via ${input.providerLabel}` : "";
      const header = `Reply received${via}: ${input.subject || "(no subject)"}`;
      db()
        .prepare(`INSERT INTO activities (kind, body, company_id, contact_id, deal_id) VALUES ('email-in', ?, ?, ?, ?)`)
        .run(input.body ? `${header}\n\n${input.body}` : header, companyId, contactId, dealId);
      db()
        .prepare(`INSERT INTO tasks (title, due, contact_id) VALUES (?, date('now'), ?)`)
        .run(`Reply to ${contactNameFor(contactId)}`, contactId);
      audit({
        action: "reply.effect.reply",
        entity: "contact",
        entityId: contactId,
        detail: { replyId, matchedMessageId, cancelled },
      });
    }
  } else if (kind === "bounce") {
    if (contactId) {
      db().prepare(`UPDATE contacts SET email_status = 'no-mx' WHERE id = ?`).run(contactId);
      const cancelled = cancelQueuedFor(contactId);
      audit({ action: "reply.effect.bounce", entity: "contact", entityId: contactId, detail: { replyId, cancelled } });
    }
  } else if (kind === "unsubscribe") {
    db().prepare(`INSERT OR IGNORE INTO suppression (email, reason) VALUES (?, 'unsubscribe')`).run(fromEmail);
    if (contactId) {
      db().prepare(`UPDATE contacts SET do_not_contact = 1 WHERE id = ?`).run(contactId);
      const cancelled = cancelQueuedFor(contactId);
      audit({
        action: "reply.effect.unsubscribe",
        entity: "contact",
        entityId: contactId,
        detail: { replyId, cancelled },
      });
    }
  } else if (kind === "auto-reply" && contactId && input.body) {
    // Out-of-office and other auto-replies are kept on the timeline with their
    // full text, but they open no deal and do not count as a reply.
    db()
      .prepare(`INSERT INTO activities (kind, body, company_id, contact_id) VALUES ('email-in', ?, ?, ?)`)
      .run(
        `Auto reply received${input.providerLabel ? ` via ${input.providerLabel}` : ""}: ${input.subject || "(no subject)"}\n\n${input.body}`,
        companyIdFor(contactId),
        contactId
      );
  }
  // auto-reply: recorded, no further effect.

  return { inserted: true, kind, replyId, contactId, dealOpened };
}

export type SyncResult = {
  ok: boolean;
  fetched: number;
  inserted: number;
  error?: string;
};

function apolloErrorMessage(err: unknown): string {
  if (err instanceof ApolloNotConfigured) return "Apollo is not configured.";
  if (err instanceof ApolloAuthError) return "Apollo rejected the configured API key.";
  if (err instanceof ApolloRateLimited) return "Apollo is rate limiting this account right now.";
  if (err instanceof ApolloRequestError) return "Apollo request failed.";
  return "Unexpected error contacting Apollo.";
}

// Manual-trigger only, never on a timer. Pulls one page of recent Apollo
// messages, classifies each, and ingests it. Read-only against Apollo (no
// credits spent) but writes locally, so every run and every failure is
// audited.
export async function syncReplies(): Promise<SyncResult> {
  if (!isConfigured()) {
    return { ok: false, fetched: 0, inserted: 0, error: "Apollo is not configured." };
  }

  try {
    const result = await searchEmailerMessages({ page: 1, perPage: 100 });
    let inserted = 0;
    for (const m of result.results) {
      if (!m.fromEmail) continue;
      const receivedAt = m.receivedAt || new Date().toISOString();
      const providerId = m.id || `${m.fromEmail}-${receivedAt}`;
      const out = ingestReply({
        providerId,
        fromEmail: m.fromEmail,
        subject: m.subject,
        snippet: m.snippet,
        headers: m.headers,
        receivedAt,
      });
      if (out.inserted) inserted += 1;
    }
    audit({ action: "replies.sync", entity: "inbound_replies", detail: { fetched: result.results.length, inserted } });
    return { ok: true, fetched: result.results.length, inserted };
  } catch (err) {
    const message = apolloErrorMessage(err);
    audit({ action: "replies.sync.error", entity: "inbound_replies", detail: { error: message } });
    return { ok: false, fetched: 0, inserted: 0, error: message };
  }
}
