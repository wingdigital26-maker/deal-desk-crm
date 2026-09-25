export const runtime = "nodejs";
// Owner-only, manual trigger: pull replies received through Instantly since
// the stored cursor. Read-only against Instantly; writes locally (replies,
// timeline, replier rule, first-stage deals), every step audited.
import { requireUser } from "../../../lib/session";
import { pollInstantlyReplies } from "../../../lib/replies/instantly";

export async function POST() {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  const result = await pollInstantlyReplies({ actorUserId: user.id });
  if (!result.ok) {
    const status = result.error === "Instantly is not configured." ? 503 : 502;
    return Response.json(result, { status });
  }
  return Response.json(result);
}
