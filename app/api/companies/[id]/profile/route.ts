export const runtime = "nodejs";
import { requireUser } from "../../../../lib/session";
import { getCompanyProfile } from "../../../../lib/profile";

// The banker profile for one company: owner, business, why-now signals, fit
// flags and sell-readiness hints, every value with its source.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const companyId = Number(id);
  if (!Number.isInteger(companyId) || companyId <= 0) return Response.json({ error: "Invalid id" }, { status: 400 });
  const profile = getCompanyProfile(companyId);
  if (!profile) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ profile });
}
