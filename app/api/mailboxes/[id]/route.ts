export const runtime = "nodejs";
// Update a mailbox: pause/unpause, or set/change the warmup start date.
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const { id } = await params;
  const mailboxId = Number(id);
  if (!Number.isInteger(mailboxId)) return Response.json({ error: "Invalid id." }, { status: 400 });

  let payload: { paused?: boolean; warmupStarted?: string | null; dailyCap?: number | string | null };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const mailbox = db().prepare(`SELECT id FROM mailboxes WHERE id = ?`).get(mailboxId);
  if (!mailbox) return Response.json({ error: "Mailbox not found." }, { status: 404 });

  if (typeof payload.paused === "boolean") {
    db().prepare(`UPDATE mailboxes SET paused = ? WHERE id = ?`).run(payload.paused ? 1 : 0, mailboxId);
    audit({
      actorUserId: user.id,
      action: payload.paused ? "mailbox.pause" : "mailbox.unpause",
      entity: "mailbox",
      entityId: mailboxId,
    });
  }

  if (payload.warmupStarted !== undefined) {
    db()
      .prepare(`UPDATE mailboxes SET warmup_started = ? WHERE id = ?`)
      .run(payload.warmupStarted, mailboxId);
    audit({
      actorUserId: user.id,
      action: "mailbox.warmup-set",
      entity: "mailbox",
      entityId: mailboxId,
      detail: { warmupStarted: payload.warmupStarted },
    });
  }

  if (payload.dailyCap !== undefined) {
    let cap: number | null = null;
    if (payload.dailyCap !== null && payload.dailyCap !== "") {
      cap = Number(payload.dailyCap);
      if (!Number.isInteger(cap) || cap < 0 || cap > 1000) {
        return Response.json({ error: "Daily cap must be a whole number from 0 to 1000." }, { status: 400 });
      }
    }
    db().prepare(`UPDATE mailboxes SET daily_cap = ? WHERE id = ?`).run(cap, mailboxId);
    audit({
      actorUserId: user.id,
      action: "mailbox.cap-set",
      entity: "mailbox",
      entityId: mailboxId,
      detail: { dailyCap: cap },
    });
  }

  return Response.json({ ok: true });
}
