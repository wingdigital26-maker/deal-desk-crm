// Opt-out plumbing shared by the queue step (mints the token), the public
// /u/[token] page, and the public /api/unsubscribe/[token] route.
import { randomBytes } from "node:crypto";
import { db } from "../db";

/** 32 random bytes, URL-safe base64. Unguessable and short enough for a link. */
export function generateUnsubscribeToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The absolute unsubscribe URL for a token. Throws with a clear message if
 * APP_BASE_URL is not configured: a message can never be queued without a
 * working opt-out link, so this failure must stop queueing, not silently
 * produce a broken or relative URL.
 */
export function unsubscribeUrlFor(token: string): string {
  const base = process.env.APP_BASE_URL;
  if (!base) {
    throw new Error(
      "APP_BASE_URL is not set. Every outbound message needs a working unsubscribe link, so queueing cannot proceed without it."
    );
  }
  return `${base.replace(/\/+$/, "")}/u/${token}`;
}

/**
 * RFC 8058 one-click headers for providers that accept custom send headers.
 * List-Unsubscribe-Post tells compliant mail clients to POST the literal
 * body "List-Unsubscribe=One-Click" to the List-Unsubscribe URL, which
 * app/api/unsubscribe/[token]/route.ts recognizes and honors with no
 * confirmation page.
 */
export function listUnsubscribeHeaders(token: string): {
  "List-Unsubscribe": string;
  "List-Unsubscribe-Post": string;
} {
  const url = unsubscribeUrlFor(token);
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

const RATE_WINDOW_MINUTES = 10;
const RATE_MAX = 30;

/**
 * Fixed-window rate limit backed by the login_attempts table (bucket +
 * created_at), so it survives restarts and works across multiple instances,
 * unlike the in-memory map the login route uses. Records the attempt as a
 * side effect so a single call is enough per request.
 */
export function rateLimitAndRecord(bucket: string, max = RATE_MAX, windowMinutes = RATE_WINDOW_MINUTES): boolean {
  const row = db()
    .prepare(
      `SELECT COUNT(*) as n FROM login_attempts WHERE bucket = ? AND created_at >= datetime('now', ?)`
    )
    .get(bucket, `-${windowMinutes} minutes`) as { n: number };
  db().prepare(`INSERT INTO login_attempts (bucket) VALUES (?)`).run(bucket);
  return row.n >= max;
}
