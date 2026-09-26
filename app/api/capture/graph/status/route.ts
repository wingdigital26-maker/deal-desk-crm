export const runtime = "nodejs";
// Read-only: reports whether Outlook capture is on and which settings are
// missing (names only, never values). Never calls Microsoft.
import { requireUser } from "../../../../lib/session";
import { graphRefusal, graphStatus } from "../../../../lib/graph/config";

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;
  return Response.json({ ...graphStatus(), message: graphRefusal() ?? "Outlook capture is on." });
}
