export const runtime = "nodejs";

import { db, audit } from "../../lib/db";
import { requireUser } from "../../lib/session";
import { firm } from "../../../firm.config";
import * as v from "../../lib/validate";

const VALID_SITUATIONS = new Set(["growth-partner", "succession", "strategic-transition", "other"]);

type DealRow = {
  id: number;
  company_id: number;
  primary_contact_id: number | null;
  title: string;
  stage: string;
  situation: string | null;
  next_step: string | null;
  next_step_due: string | null;
  owner_user_id: number | null;
  created_at: string;
  updated_at: string;
  company_name: string | null;
  company_domain: string | null;
  last_activity_at: string | null;
};

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";

  const rows = q
    ? (db()
        .prepare(
          `SELECT d.*, c.name AS company_name, c.domain AS company_domain,
                  (SELECT MAX(a.created_at) FROM activities a WHERE a.deal_id = d.id) AS last_activity_at,
                  (SELECT COUNT(*) FROM contacts p WHERE p.company_id = d.company_id) AS people_count,
                  (SELECT COUNT(*) FROM contacts p WHERE p.company_id = d.company_id AND p.relationship IN ('knows-well','knows')) AS known_count,
                  (SELECT GROUP_CONCAT(TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')), ', ') FROM
                     (SELECT first_name, last_name FROM contacts WHERE company_id = d.company_id AND relationship IN ('knows-well','knows')
                      ORDER BY CASE relationship WHEN 'knows-well' THEN 0 ELSE 1 END, last_name LIMIT 3) p) AS known_names
           FROM deals d
           JOIN companies c ON c.id = d.company_id
           WHERE d.title LIKE ? OR c.name LIKE ?
           ORDER BY d.updated_at DESC
           LIMIT 8`
        )
        .all(`%${q}%`, `%${q}%`) as DealRow[])
    : (db()
        .prepare(
          `SELECT d.*, c.name AS company_name, c.domain AS company_domain,
                  (SELECT MAX(a.created_at) FROM activities a WHERE a.deal_id = d.id) AS last_activity_at,
                  (SELECT COUNT(*) FROM contacts p WHERE p.company_id = d.company_id) AS people_count,
                  (SELECT COUNT(*) FROM contacts p WHERE p.company_id = d.company_id AND p.relationship IN ('knows-well','knows')) AS known_count,
                  (SELECT GROUP_CONCAT(TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')), ', ') FROM
                     (SELECT first_name, last_name FROM contacts WHERE company_id = d.company_id AND relationship IN ('knows-well','knows')
                      ORDER BY CASE relationship WHEN 'knows-well' THEN 0 ELSE 1 END, last_name LIMIT 3) p) AS known_names
           FROM deals d
           JOIN companies c ON c.id = d.company_id
           ORDER BY d.updated_at DESC`
        )
        .all() as DealRow[]);

  return Response.json({ items: rows });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let companyId: number, title: string, stage: string, situation: string | null, nextStep: string | null, nextStepDue: string | null;
  try {
    companyId = v.integerRange("company_id", body.company_id, 1, Number.MAX_SAFE_INTEGER, { required: true })!;
    title = v.title("title", body.title, { required: true })!;
    stage = v.enumFromList("stage", body.stage, firm.dealStages, { fallback: firm.dealStages[0] })!;
    situation = v.enumFromList("situation", body.situation, [...VALID_SITUATIONS] as string[]);
    nextStep = v.boundedString("next_step", body.next_step, 500);
    nextStepDue = v.isoDate("next_step_due", body.next_step_due);
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const company = db().prepare("SELECT id FROM companies WHERE id = ?").get(companyId);
  if (!company) {
    return Response.json({ error: "Unknown company_id" }, { status: 400 });
  }

  const result = db()
    .prepare(
      `INSERT INTO deals (company_id, title, stage, situation, next_step, next_step_due, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(companyId, title, stage, situation, nextStep, nextStepDue, user.id);

  const dealId = Number(result.lastInsertRowid);

  audit({
    actorUserId: user.id,
    action: "deal.create",
    entity: "deal",
    entityId: dealId,
    detail: { title, stage, company_id: companyId },
  });

  const created = db().prepare("SELECT * FROM deals WHERE id = ?").get(dealId);
  return Response.json({ item: created }, { status: 201 });
}
