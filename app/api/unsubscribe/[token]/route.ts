export const runtime = "nodejs";
// PUBLIC route (see proxy.ts). No requireUser: a recipient who never logs in
// must be able to opt out. Idempotent, rate limited, and never reveals
// whether a token exists beyond one generic outcome. Also the RFC 8058
// one-click landing point: mail clients POST here with the literal body
// "List-Unsubscribe=One-Click" and expect a plain 2xx, no redirect.
import { NextResponse } from "next/server";
import { db, audit } from "../../../lib/db";
import { rateLimitAndRecord } from "../../../lib/outbound/unsubscribe";

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ip = clientIp(req);

  // 30 per 10 minutes per IP. Checked and recorded before anything else runs,
  // so a flood cannot be used to brute-force tokens or hammer the database.
  if (rateLimitAndRecord(`unsub:${ip}`)) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }

  let isOneClick = false;
  try {
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("text/plain")) {
      const text = await req.text();
      isOneClick = text.trim() === "List-Unsubscribe=One-Click";
    }
  } catch {
    // A body that cannot be read is treated as a normal (non-one-click) request.
  }

  const message = db()
    .prepare(`SELECT id, contact_id FROM outbound_messages WHERE unsubscribe_token = ?`)
    .get(token) as { id: number; contact_id: number } | undefined;

  if (message) {
    const contact = db()
      .prepare(`SELECT id, email FROM contacts WHERE id = ?`)
      .get(message.contact_id) as { id: number; email: string | null } | undefined;

    if (contact?.email) {
      const email = contact.email.toLowerCase();
      db().prepare(`INSERT OR IGNORE INTO suppression (email, reason) VALUES (?, 'unsubscribe')`).run(email);
      db()
        .prepare(`UPDATE contacts SET do_not_contact = 1, unsubscribed_at = COALESCE(unsubscribed_at, datetime('now')) WHERE id = ?`)
        .run(contact.id);
      db()
        .prepare(`UPDATE outbound_messages SET status = 'cancelled' WHERE contact_id = ? AND status IN ('queued','held')`)
        .run(contact.id);
      audit({
        actorLabel: "recipient",
        action: "contact.unsubscribe",
        entity: "contact",
        entityId: contact.id,
        detail: { via: isOneClick ? "one-click" : "form" },
      });
    }
  }
  // No `else`: an unknown token does exactly the same thing (nothing, then
  // the same generic response) as a known one whose email already lacked an
  // address, so the response can never be used to test whether a token is real.

  if (isOneClick) {
    return new NextResponse("OK", { status: 200 });
  }
  return NextResponse.redirect(new URL(`/u/${token}`, req.url), { status: 303 });
}
