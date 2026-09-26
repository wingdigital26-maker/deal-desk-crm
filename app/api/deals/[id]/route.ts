export const runtime = "nodejs";

import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import { firm } from "../../../../firm.config";
import * as v from "../../../lib/validate";

const VALID_STAGES = new Set<string>(firm.dealStages);
const VALID_SITUATIONS = new Set(["growth-partner", "succession", "strategic-transition", "other"]);

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const deal = db()
    .prepare(
      `SELECT d.*, c.name AS company_name, c.domain AS company_domain
       FROM deals d JOIN companies c ON c.id = d.company_id WHERE d.id = ?`
    )
    .get(id);
  if (!deal) return Response.json({ error: "Not found" }, { status: 404 });

  const tasks = db().prepare("SELECT * FROM tasks WHERE deal_id = ? ORDER BY (due IS NULL), due ASC").all(id);
  const timeline = db()
    .prepare("SELECT * FROM activities WHERE deal_id = ? ORDER BY created_at DESC")
    .all(id);

  return Response.json({ item: deal, tasks, timeline });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const existing = db().prepare("SELECT * FROM deals WHERE id = ?").get(id) as
    | { id: number; stage: string; company_id: number }
    | undefined;
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  const detail: Record<string, unknown> = {};

  try {
    if ("title" in body) {
      const title = v.title("title", body.title, { required: true })!;
      fields.push("title = ?");
      values.push(title);
    }
    if (typeof body.stage === "string") {
      if (!VALID_STAGES.has(body.stage)) {
        return Response.json({ error: "Invalid stage" }, { status: 400 });
      }
      fields.push("stage = ?");
      values.push(body.stage);
      detail.from_stage = existing.stage;
      detail.to_stage = body.stage;
    }
    if (body.situation === null || body.situation === "") {
      // "Not set" in the deal form clears the situation.
      fields.push("situation = ?");
      values.push(null);
    } else if (typeof body.situation === "string") {
      if (!VALID_SITUATIONS.has(body.situation)) {
        return Response.json({ error: "Invalid situation" }, { status: 400 });
      }
      fields.push("situation = ?");
      values.push(body.situation);
    }
    if ("next_step" in body) {
      fields.push("next_step = ?");
      values.push(v.boundedString("next_step", body.next_step, 500));
    }
    if ("next_step_due" in body) {
      fields.push("next_step_due = ?");
      values.push(v.isoDate("next_step_due", body.next_step_due));
    }
    // Deal economics (P1). Each is optional; "" or null clears it.
    const money: [string, (f: string, x: unknown) => number | null][] = [
      ["retainer", v.money],
      ["ebitda", v.money],
      ["enterprise_value", v.money],
      ["success_fee_pct", v.percent],
      ["probability", (f, x) => v.integerRange(f, x, 0, 100)],
    ];
    for (const [key, check] of money) {
      if (key in body) {
        const val = check(key, body[key]);
        fields.push(`${key} = ?`);
        values.push(val);
        detail[key] = val;
      }
    }
    if ("fee_terms" in body) {
      fields.push("fee_terms = ?");
      values.push(v.boundedString("fee_terms", body.fee_terms, 1000));
      detail.fee_terms_changed = true;
    }
    if ("expected_close" in body) {
      const val = v.isoDate("expected_close", body.expected_close);
      fields.push("expected_close = ?");
      values.push(val);
      detail.expected_close = val;
    }
    // P5: 1 turns on the bank / credit union regulatory approval tracker.
    if ("fig_track" in body) {
      const raw = body.fig_track;
      const val = raw === true ? 1 : raw === false ? 0 : v.integerRange("fig_track", raw, 0, 1, { required: true });
      fields.push("fig_track = ?");
      values.push(val);
      detail.fig_track = val;
    }
    if ("primary_contact_id" in body) {
      const pcid =
        body.primary_contact_id != null && body.primary_contact_id !== ""
          ? v.integerRange("primary_contact_id", body.primary_contact_id, 1, Number.MAX_SAFE_INTEGER)
          : null;
      fields.push("primary_contact_id = ?");
      values.push(pcid);
    }
    // P3: who sourced the deal. Credit on the Referral sources screen follows this column.
    if ("referral_contact_id" in body) {
      const rid =
        body.referral_contact_id != null && body.referral_contact_id !== ""
          ? v.integerRange("referral_contact_id", body.referral_contact_id, 1, Number.MAX_SAFE_INTEGER)
          : null;
      if (rid != null && !db().prepare("SELECT 1 FROM contacts WHERE id = ?").get(rid)) {
        return Response.json({ error: "Unknown contact", field: "referral_contact_id" }, { status: 400 });
      }
      fields.push("referral_contact_id = ?");
      values.push(rid);
      detail.referral_contact_id = rid;
      detail.from_referral_contact_id = (existing as { referral_contact_id?: number | null }).referral_contact_id ?? null;
    }
  } catch (err) {
    const res = v.validationErrorResponse(err);
    if (res) return res;
    throw err;
  }

  if (fields.length === 0) {
    return Response.json({ error: "No valid fields to update" }, { status: 400 });
  }

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db()
    .prepare(`UPDATE deals SET ${fields.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number | null)[]));

  const stageChanged = typeof body.stage === "string" && body.stage !== existing.stage;
  if (stageChanged) {
    db()
      .prepare(
        `INSERT INTO activities (kind, body, deal_id, company_id, user_id) VALUES ('stage-change', ?, ?, ?, ?)`
      )
      .run(`Moved from ${existing.stage} to ${body.stage}`, id, existing.company_id, user.id);
  }

  audit({
    actorUserId: user.id,
    action: "deal.update",
    entity: "deal",
    entityId: id,
    detail,
  });

  const updated = db().prepare("SELECT * FROM deals WHERE id = ?").get(id);
  return Response.json({ item: updated });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  const id = parseId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });

  const existing = db().prepare("SELECT id FROM deals WHERE id = ?").get(id);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  // Buyer history and documents are records (17a-4) and RESTRICT the delete.
  // Refuse cleanly instead of letting the foreign key surface as a 500.
  const held = db()
    .prepare(
      "SELECT (SELECT COUNT(*) FROM deal_buyers WHERE deal_id = ?) AS buyers, (SELECT COUNT(*) FROM documents WHERE deal_id = ?) AS docs"
    )
    .get(id, id) as { buyers: number; docs: number };
  if (held.buyers || held.docs) {
    return Response.json(
      { error: "This deal has a buyer log or documents on record, which must be kept. Move it to Passed instead of deleting it." },
      { status: 409 }
    );
  }
  db().prepare("DELETE FROM deals WHERE id = ?").run(id);

  audit({ actorUserId: user.id, action: "deal.delete", entity: "deal", entityId: id });

  return Response.json({ ok: true });
}
