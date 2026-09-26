export const runtime = "nodejs";

import { audit } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import { exportResponse, parseFormat } from "../../../../lib/export";
import { reportSheets, sellerReport } from "../../../../lib/sellerReport";

// GET ?format=json (default) | csv | xlsx. Downloads are audited: the report
// carries buyer names and bid values, which are MNPI until the deal is public.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid id" }, { status: 400 });
  const report = sellerReport(id);
  if (!report) return Response.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const format = parseFormat(url);
  if (!format) return Response.json(report);

  audit({ actorUserId: user.id, action: "deal.seller_report.export", entity: "deal", entityId: id, detail: { format, buyers: report.items.length } });
  const sheets = reportSheets(report);
  // CSV is one sheet: the buyer log. XLSX carries summary, buyers, terms and history.
  const slug = report.deal.company_name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "deal";
  return exportResponse(format, `${slug}-buyer-log`, format === "csv" ? [sheets[1]] : sheets);
}
