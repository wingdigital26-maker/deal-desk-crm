// Outlook auto-capture: turns mail and meetings in ONE mailbox into timeline
// activities for contacts that ALREADY exist in the CRM.
//
// Rules, on purpose:
// - Known contacts only. A message or meeting with no participant whose address
//   matches contacts.email is skipped. Contacts are never created here, so the
//   CRM never fills up with newsletters, vendors and internal chatter.
// - Metadata plus a short preview only (max 500 chars). The firm's Outlook
//   archive stays the book of record; this is a convenience copy.
// - Idempotent. captured_items holds one row per (provider item, contact), so
//   re-running a sync, or overlapping cursors, never writes a duplicate.
// - Read only against Microsoft. Nothing is sent, moved or flagged.
import { db } from "../db";
import { graphConfig, graphRefusal } from "./config";
import { getToken, listEvents, listMessages, MAX_PAGES, type FetchLike, type GraphAddress } from "./client";

export const MESSAGES_CURSOR = "graph.messages";
export const EVENTS_CURSOR = "graph.events";
const PROVIDER_MAIL = "graph.mail";
const PROVIDER_EVENT = "graph.event";
const LOOKBACK_DAYS = 30;
const BODY_MAX = 500;
const PAGE_CAP_ITEMS = MAX_PAGES * 50;

export type CaptureCounts = {
  messagesSeen: number;
  eventsSeen: number;
  activitiesWritten: number;
  skippedUnknown: number;
};

export type CaptureResult = { ok: true; counts: CaptureCounts } | { ok: false; error: string };

function getCursor(name: string): string | null {
  const row = db().prepare("SELECT value FROM sync_cursors WHERE name = ?").get(name) as { value: string } | undefined;
  return row?.value ?? null;
}

function setCursor(name: string, value: string) {
  db()
    .prepare(
      `INSERT INTO sync_cursors (name, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(name, value);
}

const addr = (a: GraphAddress | null | undefined) => (a?.emailAddress?.address || "").trim().toLowerCase();

/** Graph instant -> the "YYYY-MM-DD HH:MM:SS" UTC shape the rest of the schema uses. */
function toSqlTime(value: string | null | undefined, fallback: Date): string {
  let d = fallback;
  if (value) {
    const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
    const parsed = new Date(withZone);
    if (!Number.isNaN(parsed.getTime())) d = parsed;
  }
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > BODY_MAX ? `${flat.slice(0, BODY_MAX - 3).trimEnd()}...` : flat;
}

type KnownContact = { id: number; company_id: number | null };

function contactsFor(addresses: Iterable<string>): KnownContact[] {
  const stmt = db().prepare("SELECT id, company_id FROM contacts WHERE lower(email) = ? ORDER BY id LIMIT 1");
  const seen = new Map<number, KnownContact>();
  for (const a of addresses) {
    if (!a) continue;
    const row = stmt.get(a) as KnownContact | undefined;
    if (row) seen.set(row.id, row);
  }
  return [...seen.values()];
}

/** Writes one activity per contact unless (provider, externalId, contact) was captured before. */
function record(
  provider: string,
  externalId: string,
  contacts: KnownContact[],
  kind: string,
  body: string,
  createdAt: string,
  userId: number | null
): number {
  const d = db();
  const claim = d.prepare(
    "INSERT INTO captured_items (provider, external_id, contact_id) VALUES (?,?,?) ON CONFLICT(provider, external_id, contact_id) DO NOTHING"
  );
  const insertActivity = d.prepare(
    "INSERT INTO activities (kind, body, company_id, contact_id, user_id, created_at) VALUES (?,?,?,?,?,?)"
  );
  const link = d.prepare("UPDATE captured_items SET activity_id = ? WHERE id = ?");
  let written = 0;
  d.exec("BEGIN");
  try {
    for (const c of contacts) {
      const claimed = claim.run(provider, externalId, c.id);
      if (Number(claimed.changes) === 0) continue;
      const act = insertActivity.run(kind, body, c.company_id, c.id, userId, createdAt);
      link.run(Number(act.lastInsertRowid), Number(claimed.lastInsertRowid));
      written++;
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return written;
}

/**
 * Runs one capture pass. Refuses (ok:false) WITHOUT any network call when
 * capture is off or not fully configured.
 */
export async function captureFromGraph(opts: {
  fetchImpl?: FetchLike;
  now?: Date;
  userId?: number | null;
} = {}): Promise<CaptureResult> {
  const refusal = graphRefusal();
  const cfg = graphConfig();
  if (refusal || !cfg) return { ok: false, error: refusal || "Outlook capture is not available." };

  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? new Date();
  const userId = opts.userId ?? null;
  const mailbox = cfg.mailbox.toLowerCase();
  const defaultSince = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const counts: CaptureCounts = { messagesSeen: 0, eventsSeen: 0, activitiesWritten: 0, skippedUnknown: 0 };

  const token = await getToken(cfg, fetchImpl);

  // ---- mail
  const msgSince = getCursor(MESSAGES_CURSOR) || defaultSince;
  const messages = await listMessages(cfg, token, msgSince, fetchImpl);
  let newestReceived = msgSince;
  for (const m of messages) {
    counts.messagesSeen++;
    if (m.receivedDateTime && m.receivedDateTime > newestReceived) newestReceived = m.receivedDateTime;
    const from = addr(m.from);
    const outgoing = from === mailbox;
    const participants = new Set<string>([from, ...(m.toRecipients || []).map(addr), ...(m.ccRecipients || []).map(addr)]);
    participants.delete(mailbox);
    participants.delete("");
    const known = contactsFor(participants);
    if (known.length === 0) {
      counts.skippedUnknown++;
      continue;
    }
    const subject = (m.subject || "").trim() || "(no subject)";
    const preview = (m.bodyPreview || "").trim();
    const body = clip(preview ? `${subject}: ${preview}` : subject);
    const when = toSqlTime(outgoing ? m.sentDateTime : m.receivedDateTime, now);
    const externalId = (m.internetMessageId || "").trim() || m.id;
    counts.activitiesWritten += record(PROVIDER_MAIL, externalId, known, outgoing ? "email-out" : "email-in", body, when, userId);
  }
  setCursor(MESSAGES_CURSOR, newestReceived);

  // ---- calendar (meetings that have started by now)
  const evStart = getCursor(EVENTS_CURSOR) || defaultSince;
  const evEnd = now.toISOString();
  const events = await listEvents(cfg, token, evStart, evEnd, fetchImpl);
  for (const ev of events) {
    counts.eventsSeen++;
    if (ev.isCancelled) continue;
    const participants = new Set<string>([addr(ev.organizer), ...(ev.attendees || []).map(addr)]);
    participants.delete(mailbox);
    participants.delete("");
    const known = contactsFor(participants);
    if (known.length === 0) {
      counts.skippedUnknown++;
      continue;
    }
    const startSql = toSqlTime(ev.start?.dateTime, now);
    const subject = (ev.subject || "").trim() || "(no subject)";
    const body = clip(`${subject} (${startSql} UTC)`);
    // One id per occurrence: recurring meetings share an iCalUId, so the id wins.
    counts.activitiesWritten += record(PROVIDER_EVENT, ev.id, known, "meeting", body, startSql, userId);
  }
  // If the page cap truncated the window, resume from the last start seen next time.
  const last = events[events.length - 1];
  const truncated = events.length >= PAGE_CAP_ITEMS && last?.start?.dateTime;
  setCursor(EVENTS_CURSOR, truncated ? toSqlTime(last.start!.dateTime, now).replace(" ", "T") + "Z" : evEnd);

  return { ok: true, counts };
}
