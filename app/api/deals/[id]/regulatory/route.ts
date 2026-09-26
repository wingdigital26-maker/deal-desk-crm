export const runtime = "nodejs";

import { requireUser } from "../../../../lib/session";
import * as v from "../../../../lib/validate";
import { RegulatoryError, addEntry, deleteEntry, regulatoryState, updateEntry } from "../../../../lib/regulatoryStore";

// P5 regulatory tracker for one deal. GET returns filings (with suggested
// dates, never saved), shareholder votes and the fig_track flag.
// POST {type:'filing'|'vote', ...} adds, PATCH {type, id, ...} edits,
// DELETE ?type=&id= removes. Every change is audited.

function dealId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

function fail(err: unknown): Response {
  if (err instanceof RegulatoryError) return Response.json({ error: err.message, field: err.field }, { status: err.status });
  const res = v.validationErrorResponse(err);
  if (res) return res;
  throw err;
}

function state(id: number, status = 200): Response {
  const s = regulatoryState(id);
  if (!s) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(s, { status });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = dealId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  return state(id);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = dealId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  const body = await readBody(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  try {
    addEntry(id, body, user.id);
  } catch (err) {
    return fail(err);
  }
  return state(id, 201);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = dealId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  const body = await readBody(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  try {
    updateEntry(id, body, user.id);
  } catch (err) {
    return fail(err);
  }
  return state(id);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = dealId((await ctx.params).id);
  if (!id) return Response.json({ error: "Invalid id" }, { status: 400 });
  const q = new URL(req.url).searchParams;
  try {
    deleteEntry(id, q.get("type"), q.get("id"), user.id);
  } catch (err) {
    return fail(err);
  }
  return state(id);
}
