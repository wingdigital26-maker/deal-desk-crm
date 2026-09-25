export const runtime = "nodejs";
// Read-only, filterable, paginated audit trail. No update or delete endpoint
// exists for audit_log anywhere in this app: it is append-only by construction.
import { db } from "../../lib/db";
import { requireUser } from "../../lib/session";
import type { SQLInputValue } from "node:sqlite";

type AuditRow = {
  id: number;
  actor_user_id: number | null;
  actor_label: string | null;
  action: string;
  entity: string | null;
  entity_id: number | null;
  detail_json: string;
  created_at: string;
};

const PAGE_SIZE = 50;

function buildFilter(url: URL) {
  const action = url.searchParams.get("action");
  const entity = url.searchParams.get("entity");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (action) {
    clauses.push("action = ?");
    params.push(action);
  }
  if (entity) {
    clauses.push("entity = ?");
    params.push(entity);
  }
  if (from) {
    // created_at is "YYYY-MM-DD HH:MM:SS"; compare on the date part so the
    // picked day itself is included.
    clauses.push("date(created_at) >= date(?)");
    params.push(from);
  }
  if (to) {
    clauses.push("date(created_at) <= date(?)");
    params.push(to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}

function csvEscape(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  // Neutralize spreadsheet formula injection: a cell that opens with =, +, -, @
  // or a tab is prefixed with an apostrophe so it never executes as a formula.
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: Request) {
  const user = await requireUser(["owner", "principal"]);
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const { where, params } = buildFilter(url);
  const format = url.searchParams.get("format");

  if (format === "csv") {
    const rows = db()
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC`)
      .all(...params) as AuditRow[];
    const header = ["id", "created_at", "actor_user_id", "actor_label", "action", "entity", "entity_id", "detail_json"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [r.id, r.created_at, r.actor_user_id, r.actor_label, r.action, r.entity, r.entity_id, r.detail_json]
          .map(csvEscape)
          .join(",")
      );
    }
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit_log.csv"`,
      },
    });
  }

  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const total = (
    db().prepare(`SELECT COUNT(*) as c FROM audit_log ${where}`).get(...params) as { c: number }
  ).c;

  const rows = db()
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, offset) as AuditRow[];

  return Response.json({ rows, page, pageSize: PAGE_SIZE, total, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) });
}
