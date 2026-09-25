export const runtime = "nodejs";
import { db, audit } from "../../../../../lib/db";
import { requireUser } from "../../../../../lib/session";
import { runProfileRefresh } from "../../../../../lib/profileRun";

// Owner only: re-run the public-source enrichment for this one company. It makes
// outbound web requests (company site, TX registry, news), so it is never
// triggered by anyone else and every run is audited.
const inFlight = new Set<number>();

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;
  const { id } = await params;
  const companyId = Number(id);
  if (!Number.isInteger(companyId) || companyId <= 0) return Response.json({ error: "Invalid id" }, { status: 400 });
  const company = db().prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId) as { id: number; name: string } | undefined;
  if (!company) return Response.json({ error: "Not found" }, { status: 404 });
  if (inFlight.has(companyId)) return Response.json({ error: "A refresh for this company is already running" }, { status: 409 });

  inFlight.add(companyId);
  try {
    const result = await runProfileRefresh(companyId);
    audit({
      actorUserId: user.id,
      actorLabel: user.email,
      action: "profile.refresh",
      entity: "company",
      entityId: companyId,
      detail: result.ok ? { ok: true, writes: result.writes, pages: result.pages, registry: result.registry } : { ok: false, error: result.error },
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.unavailable ? 503 : 502 });
    return Response.json({ ok: true, result });
  } finally {
    inFlight.delete(companyId);
  }
}
