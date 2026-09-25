export const runtime = "nodejs";
// Owner-only: pull the sending accounts from Instantly into Mailboxes.
// Read-only against Instantly.
//
// This Instantly workspace may be SHARED with another tenant's
// campaigns and sending domains, so the import is restricted to
// INSTANTLY_ALLOWED_DOMAINS (see app/lib/instantly/client.ts). If that list
// is empty, this refuses to import anything and says so, rather than
// pulling in another tenant's mailboxes.
import { requireUser } from "../../../../lib/session";
import { isInstantlyConfigured, InstantlyRequestError, getAllowedDomains } from "../../../../lib/instantly/client";
import { syncInstantlyAccounts } from "../../../../lib/instantly/accounts";

export async function POST() {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  if (!isInstantlyConfigured()) {
    return Response.json({ error: "Instantly is not configured." }, { status: 503 });
  }
  if (getAllowedDomains().length === 0) {
    return Response.json(
      { error: "No firm sending domains are set yet. Set INSTANTLY_ALLOWED_DOMAINS to import mailboxes." },
      { status: 409 }
    );
  }
  try {
    const result = await syncInstantlyAccounts(user.id);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof InstantlyRequestError ? err.message : "Could not reach Instantly.";
    return Response.json({ error: message }, { status: 502 });
  }
}
