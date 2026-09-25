export const runtime = "nodejs";
import { db, audit } from "../../lib/db";
import { requireUser } from "../../lib/session";
import { firm } from "../../../firm.config";
import * as v from "../../lib/validate";

const SORTS: Record<string, string> = {
  signal_score: "signal_score DESC, id DESC",
  updated_at: "updated_at DESC, id DESC",
  name: "name COLLATE NOCASE ASC, id ASC",
};

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const segment = url.searchParams.get("segment") ?? "";
  const source = url.searchParams.get("source") ?? "";
  const sort = SORTS[url.searchParams.get("sort") ?? ""] ?? SORTS.updated_at;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q) {
    where.push("(name LIKE ? OR domain LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (segment) {
    where.push("segment_id = ?");
    params.push(segment);
  }
  if (source) {
    where.push("source = ?");
    params.push(source);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = db()
    .prepare(`SELECT COUNT(*) AS n FROM companies ${whereSql}`)
    .get(...params) as { n: number };

  const rows = db()
    .prepare(`SELECT * FROM companies ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);

  return Response.json({ rows, total: total.n, page, pageSize });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Invalid body" }, { status: 400 });

  let name: string, industry: string | null, city: string | null, state: string | null, revenueBand: string | null, notes: string | null, employeesCount: number | null;
  try {
    name = v.name("name", body.name, { required: true })!;
    industry = v.boundedString("industry", body.industry, 200);
    city = v.boundedString("city", body.city, 200);
    state = v.boundedString("state", body.state, 200);
    revenueBand = v.boundedString("revenue_band", body.revenue_band, 200);
    notes = v.notes("notes", body.notes);
    employeesCount = v.employees("employees", body.employees);
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }
  const domain = typeof body.domain === "string" && body.domain.trim() ? normalizeDomain(body.domain) : null;
  const segmentIds = firm.segments.map((s) => s.id);
  const segmentId = segmentIds.includes(body.segment_id) ? body.segment_id : segmentIds[0];
  const employees = employeesCount;
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "manual";

  if (domain) {
    const existing = db().prepare("SELECT id FROM companies WHERE domain = ?").get(domain) as { id: number } | undefined;
    if (existing) {
      return Response.json({ error: "A company with this domain already exists", id: existing.id }, { status: 409 });
    }
  }

  try {
    const result = db()
      .prepare(
        `INSERT INTO companies (name, domain, segment_id, industry, city, state, employees, revenue_band, source, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(name, domain, segmentId, industry, city, state, employees, revenueBand, source, notes);
    const id = Number(result.lastInsertRowid);
    audit({ actorUserId: user.id, actorLabel: user.email, action: "company.create", entity: "company", entityId: id, detail: { name } });
    return Response.json({ id }, { status: 201 });
  } catch {
    return Response.json({ error: "Could not create the company" }, { status: 400 });
  }
}

export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}
