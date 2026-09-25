export const runtime = "nodejs";
// Reports whether Apollo is configured, and if so, which email accounts and
// sequences exist. Never returns key material.
import { requireUser } from "../../../lib/session";
import {
  isConfigured,
  listEmailAccounts,
  listSequences,
  ApolloAuthError,
  ApolloRateLimited,
  ApolloRequestError,
} from "../../../lib/apollo/client";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;

  if (!isConfigured()) {
    return Response.json({ configured: false });
  }

  try {
    const [emailAccounts, sequences] = await Promise.all([listEmailAccounts(), listSequences()]);
    return Response.json({
      configured: true,
      emailAccounts: emailAccounts.map((a) => ({ id: a.id, email: a.email, status: a.status })),
      sequences: sequences.map((s) => ({ id: s.id, name: s.name, numContacts: s.numContacts })),
    });
  } catch (err) {
    if (err instanceof ApolloAuthError) {
      return Response.json({ configured: true, error: "Apollo rejected the configured API key." }, { status: 502 });
    }
    if (err instanceof ApolloRateLimited) {
      return Response.json({ configured: true, error: "Apollo is rate limiting this account right now." }, { status: 429 });
    }
    if (err instanceof ApolloRequestError) {
      return Response.json({ configured: true, error: "Apollo request failed." }, { status: 502 });
    }
    return Response.json({ configured: true, error: "Unexpected error contacting Apollo." }, { status: 500 });
  }
}
