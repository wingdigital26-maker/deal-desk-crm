export const runtime = "nodejs";
// Manual trigger only, no timers. Owner or member can run it; it reads
// Apollo (no credits spent) and writes locally.
import { requireUser } from "../../../lib/session";
import { syncReplies } from "../../../lib/replies/sync";

export async function POST() {
  const user = await requireUser(["owner", "member"]);
  if (user instanceof Response) return user;

  const result = await syncReplies();
  if (!result.ok) {
    const status = result.error === "Apollo is not configured." ? 503 : 502;
    return Response.json(result, { status });
  }
  return Response.json(result);
}
