export const runtime = "nodejs";
// Reports remaining Apollo credits when the account's plan exposes that,
// else an honest {available:false}. Never returns key material.
import { requireUser } from "../../../lib/session";
import { isConfigured, getCreditUsage } from "../../../lib/apollo/client";

export async function GET() {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  if (!isConfigured()) {
    return Response.json({ available: false });
  }

  const usage = await getCreditUsage();
  if (!usage || usage.creditsRemaining === null) {
    return Response.json({ available: false });
  }

  return Response.json({ available: true, creditsRemaining: usage.creditsRemaining, creditsUsed: usage.creditsUsed });
}
