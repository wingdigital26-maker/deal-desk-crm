export const runtime = "nodejs";

import { requireUser } from "../../lib/session";
import { listRankedCompanies, countCompaniesBySource, countCompaniesWithSignals } from "../../lib/signals/queries";

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") || undefined;
  const segment = url.searchParams.get("segment") || undefined;
  const minScoreRaw = url.searchParams.get("min_score");
  const minScore = minScoreRaw !== null ? Number(minScoreRaw) : undefined;
  const since = url.searchParams.get("since") || undefined;

  const items = listRankedCompanies({ kind, segment, minScore, since });
  const bySource = countCompaniesBySource();
  const companiesWithSignals = countCompaniesWithSignals();

  return Response.json({ items, meta: { companies_by_source: bySource, companies_with_signals: companiesWithSignals } });
}
