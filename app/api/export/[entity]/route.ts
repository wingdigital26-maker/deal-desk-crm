export const runtime = "nodejs";
// GET /api/export/<entity>?format=csv|xlsx plus that list's filters.
// entity is a fixed allow-list (app/lib/listExports.ts); anything else is a 404.
import { audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import { exportResponse, parseFormat } from "../../../lib/export";
import { buildExport, isExportEntity } from "../../../lib/listExports";

export async function GET(req: Request, ctx: { params: Promise<{ entity: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { entity } = await ctx.params;
  if (!isExportEntity(entity)) return Response.json({ error: "Not found" }, { status: 404 });
  const url = new URL(req.url);
  const format = parseFormat(url) ?? "csv";
  const { filename, sheet } = buildExport(entity, (k) => url.searchParams.get(k));
  const filters = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "format"));
  audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: `export.${entity}`,
    entity,
    detail: { format, rows: sheet.rows.length, filters },
  });
  return exportResponse(format, filename, [sheet]);
}
