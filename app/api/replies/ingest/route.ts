export const runtime = "nodejs";
// Webhook receiver for a future mail system: protected by a shared secret
// header (never a user session), timing-safe compared, fails closed with 503
// when the secret is not configured so this endpoint is inert by default.
import { timingSafeEqual } from "node:crypto";
import { ingestReply } from "../../../lib/replies/sync";

const HEADER = "x-replies-ingest-secret";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function POST(req: Request) {
  const secret = process.env.REPLIES_INGEST_SECRET;
  if (!secret) {
    return Response.json({ error: "Reply ingestion is not configured for this workspace." }, { status: 503 });
  }

  const provided = req.headers.get(HEADER) || "";
  if (!provided || !safeEqual(provided, secret)) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const providerId = typeof body.providerId === "string" ? body.providerId : "";
  const fromEmail = typeof body.fromEmail === "string" ? body.fromEmail : "";
  if (!providerId || !fromEmail) {
    return Response.json({ error: "providerId and fromEmail are required." }, { status: 400 });
  }

  const receivedAt = typeof body.receivedAt === "string" ? body.receivedAt : new Date().toISOString();
  const subject = typeof body.subject === "string" ? body.subject : null;
  const snippet = typeof body.snippet === "string" ? body.snippet : null;
  const headers =
    body.headers && typeof body.headers === "object" ? (body.headers as Record<string, string>) : null;
  const messageId = typeof body.messageId === "number" && Number.isInteger(body.messageId) ? body.messageId : null;

  const result = ingestReply({ providerId, fromEmail, subject, snippet, headers, receivedAt, messageId });
  return Response.json(result);
}
