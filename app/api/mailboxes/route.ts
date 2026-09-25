export const runtime = "nodejs";
// List and add sending mailboxes.
import { db, audit } from "../../lib/db";
import { requireUser } from "../../lib/session";
import { firm } from "../../../firm.config";
import { dailyCapForMailbox, projection } from "../../lib/outbound/ramp";

type MailboxRow = {
  id: number;
  address: string;
  provider: string;
  warmup_started: string | null;
  paused: number;
  created_at: string;
  domain: string | null;
  daily_cap: number | null;
};

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const rows = db()
    .prepare(`SELECT id, address, provider, warmup_started, paused, created_at, domain, daily_cap FROM mailboxes ORDER BY id ASC`)
    .all() as MailboxRow[];

  const today = new Date();
  const mailboxes = rows.map((m) => ({
    ...m,
    todaysCap: dailyCapForMailbox(m.warmup_started, today, firm.outbound, !!m.paused, m.daily_cap),
  }));

  const projectionWeeks = projection(
    rows.map((m) => ({ warmupStarted: m.warmup_started, paused: !!m.paused, dailyCap: m.daily_cap })),
    firm.outbound,
    12
  );

  return Response.json({ mailboxes, projection: projectionWeeks, weeklyTarget: firm.outbound.weeklyTarget });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  let payload: {
    address?: string;
    warmupStarted?: string | null;
    provider?: string;
    dailyCap?: number | string | null;
  };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const address = (payload.address ?? "").trim().toLowerCase();
  if (!address || !address.includes("@")) {
    return Response.json({ error: "A valid mailbox address is required." }, { status: 400 });
  }
  const warmupStarted = payload.warmupStarted ? String(payload.warmupStarted) : null;
  const provider = payload.provider === "instantly" ? "instantly" : "apollo";
  let dailyCap: number | null = null;
  if (payload.dailyCap !== undefined && payload.dailyCap !== null && payload.dailyCap !== "") {
    dailyCap = Number(payload.dailyCap);
    if (!Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > 1000) {
      return Response.json({ error: "Daily cap must be a whole number from 0 to 1000." }, { status: 400 });
    }
  }
  const domain = address.slice(address.lastIndexOf("@") + 1) || null;

  try {
    const info = db()
      .prepare(`INSERT INTO mailboxes (address, provider, warmup_started, paused, domain, daily_cap) VALUES (?, ?, ?, 0, ?, ?)`)
      .run(address, provider, warmupStarted, domain, dailyCap);

    audit({
      actorUserId: user.id,
      action: "mailbox.create",
      entity: "mailbox",
      entityId: Number(info.lastInsertRowid),
      detail: { address, warmupStarted, provider, domain, dailyCap },
    });

    return Response.json({ id: Number(info.lastInsertRowid) }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create mailbox.";
    const isDuplicate = message.includes("UNIQUE");
    return Response.json({ error: isDuplicate ? "That mailbox address already exists." : message }, { status: 409 });
  }
}
