export const runtime = "nodejs";
// Manual trigger only, no timers. Owner only. Refuses with 409 and makes zero
// network calls unless GRAPH_CAPTURE_ENABLED=1 and every Graph setting is set.
import { requireUser } from "../../../../lib/session";
import { audit } from "../../../../lib/db";
import { graphRefusal } from "../../../../lib/graph/config";
import { captureFromGraph } from "../../../../lib/graph/capture";
import { GraphRequestError } from "../../../../lib/graph/client";

export async function POST() {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  const refusal = graphRefusal();
  if (refusal) return Response.json({ ok: false, error: refusal }, { status: 409 });

  try {
    const result = await captureFromGraph({ userId: user.id });
    if (!result.ok) return Response.json(result, { status: 409 });
    audit({ actorUserId: user.id, actorLabel: user.email, action: "capture.graph.sync", detail: result.counts });
    return Response.json(result);
  } catch (e) {
    const status = e instanceof GraphRequestError ? e.status : 0;
    audit({
      actorUserId: user.id,
      actorLabel: user.email,
      action: "capture.graph.sync.failed",
      detail: { status },
    });
    const error =
      status === 401 || status === 403
        ? "Microsoft refused the request. Check the app registration, admin consent and the mailbox access policy."
        : "Could not finish reading from Microsoft Graph. Anything already captured is kept and will not be duplicated. Try again later.";
    return Response.json({ ok: false, error }, { status: 502 });
  }
}
