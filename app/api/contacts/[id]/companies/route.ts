export const runtime = "nodejs";
// A contact's companies: every role the person holds or held, with dates.
// Marking a link primary also moves contacts.company_id (app/lib/contactCompanies.ts).
import { db, audit } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import * as v from "../../../../lib/validate";
import { addLink, linksForContact, parseLinkFields, removeLink, updateLink } from "../../../../lib/contactCompanies";

type Ctx = { params: Promise<{ id: string }> };

async function contactId(ctx: Ctx): Promise<number | Response> {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid id" }, { status: 400 });
  if (!db().prepare("SELECT 1 FROM contacts WHERE id = ?").get(id)) return Response.json({ error: "Not found" }, { status: 404 });
  return id;
}

function fail(err: unknown): Response {
  const res = v.validationErrorResponse(err);
  if (res) return res;
  throw err;
}

export async function GET(_req: Request, ctx: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = await contactId(ctx);
  if (id instanceof Response) return id;
  return Response.json({ items: linksForContact(id) });
}

export async function POST(req: Request, ctx: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = await contactId(ctx);
  if (id instanceof Response) return id;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Invalid body" }, { status: 400 });
  try {
    const companyId = v.integerRange("company_id", body.company_id, 1, Number.MAX_SAFE_INTEGER, { required: true })!;
    const fields = parseLinkFields(body);
    const result = addLink(id, companyId, fields, body.is_primary === true);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    audit({
      actorUserId: user.id,
      actorLabel: user.email,
      action: "contact.company.link",
      entity: "contact",
      entityId: id,
      detail: { company_id: companyId, ...fields, is_primary: result.link.is_primary },
    });
    return Response.json({ item: result.link }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = await contactId(ctx);
  if (id instanceof Response) return id;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Invalid body" }, { status: 400 });
  try {
    const companyId = v.integerRange("company_id", body.company_id, 1, Number.MAX_SAFE_INTEGER, { required: true })!;
    const fields = parseLinkFields(body);
    let primary: boolean | undefined;
    if ("is_primary" in body) {
      if (typeof body.is_primary !== "boolean") return Response.json({ error: "is_primary must be true or false", field: "is_primary" }, { status: 400 });
      primary = body.is_primary;
    }
    if (!Object.keys(fields).length && primary === undefined) return Response.json({ error: "Nothing to update" }, { status: 400 });
    const result = updateLink(id, companyId, fields, primary);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    audit({
      actorUserId: user.id,
      actorLabel: user.email,
      action: "contact.company.update",
      entity: "contact",
      entityId: id,
      detail: { company_id: companyId, ...fields, ...(primary === undefined ? {} : { is_primary: primary }) },
    });
    return Response.json({ item: result.link });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = await contactId(ctx);
  if (id instanceof Response) return id;
  try {
    const companyId = v.integerRange("company_id", new URL(req.url).searchParams.get("company_id"), 1, Number.MAX_SAFE_INTEGER, { required: true })!;
    const result = removeLink(id, companyId);
    if (!result.ok) return Response.json({ error: "No link to that company" }, { status: 404 });
    audit({
      actorUserId: user.id,
      actorLabel: user.email,
      action: "contact.company.unlink",
      entity: "contact",
      entityId: id,
      detail: { company_id: companyId, was_primary: result.wasPrimary },
    });
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
