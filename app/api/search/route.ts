export const runtime = "nodejs";
// GET /api/search?q= : companies, people and deals matching one query, 8 of each.
import { requireUser } from "../../lib/session";
import { globalSearch } from "../../lib/search";

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  return Response.json(globalSearch(new URL(req.url).searchParams.get("q")));
}
