export const runtime = "nodejs";
import { db, audit } from "../../lib/db";
import { requireUser } from "../../lib/session";
import { isValidEmail } from "../../lib/csv";
import * as v from "../../lib/validate";
import { setPrimary } from "../../lib/contactCompanies";
import { REFERRAL_KINDS } from "../../lib/referralKinds";

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const dnc = url.searchParams.get("dnc"); // "1" | "0" | null (any)
  const emailStatus = url.searchParams.get("email_status") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q) {
    where.push("(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR company_id IN (SELECT id FROM companies WHERE name LIKE ?))");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (dnc === "1") where.push("do_not_contact = 1");
  if (dnc === "0") where.push("do_not_contact = 0");
  if (emailStatus) {
    where.push("email_status = ?");
    params.push(emailStatus);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = db()
    .prepare(`SELECT COUNT(*) AS n FROM contacts ${whereSql}`)
    .get(...params) as { n: number };

  const rows = db()
    .prepare(
      `SELECT contacts.*, companies.name AS company_name
       FROM contacts LEFT JOIN companies ON companies.id = contacts.company_id
       ${whereSql} ORDER BY contacts.updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  return Response.json({ rows, total: total.n, page, pageSize });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Invalid body" }, { status: 400 });

  let firstName: string | null, lastName: string | null, title: string | null, linkedinUrl: string | null;
  let referralKind: string | null;
  try {
    referralKind = v.enumFromList("referral_kind", body.referral_kind, REFERRAL_KINDS);
    firstName = v.name("first_name", body.first_name);
    lastName = v.name("last_name", body.last_name);
    title = v.title("title", body.title);
    linkedinUrl = v.url("linkedin_url", body.linkedin_url);
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }
  if (!firstName && !lastName) {
    return Response.json({ error: "First or last name is required" }, { status: 400 });
  }
  const email = str(body.email)?.toLowerCase() ?? null;
  if (email && !isValidEmail(email)) {
    return Response.json({ error: "That email address does not look valid" }, { status: 400 });
  }
  const emailStatus = str(body.email_status);
  const phone = str(body.phone);
  let companyId: number | null = null;
  if (body.company_id != null && body.company_id !== "") {
    try {
      companyId = v.integerRange("company_id", body.company_id, 1, Number.MAX_SAFE_INTEGER);
    } catch (err) {
      const res = v.validationErrorResponse(err);
      if (res) return res;
      throw err;
    }
  }
  const source = str(body.source) ?? "manual";

  if (email) {
    const existing = db().prepare("SELECT id FROM contacts WHERE email = ?").get(email) as { id: number } | undefined;
    if (existing) {
      return Response.json({ error: "A contact with this email already exists", id: existing.id }, { status: 409 });
    }
  }

  try {
    const result = db()
      .prepare(
        `INSERT INTO contacts (company_id, first_name, last_name, title, email, email_status, phone, linkedin_url, source, referral_kind)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(companyId, firstName, lastName, title, email, emailStatus, phone, linkedinUrl, source, referralKind);
    const id = Number(result.lastInsertRowid);
    if (companyId) setPrimary(id, companyId);
    audit({ actorUserId: user.id, actorLabel: user.email, action: "contact.create", entity: "contact", entityId: id, detail: { email } });
    return Response.json({ id }, { status: 201 });
  } catch {
    return Response.json({ error: "Could not create the contact" }, { status: 400 });
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
