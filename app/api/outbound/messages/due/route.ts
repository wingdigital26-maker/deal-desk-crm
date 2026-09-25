export const runtime = "nodejs";
// Preview for the "Send what is due" control on /outbound/queue: how many
// messages are due right now, broken down by mailbox with today's remaining
// allowance, and whether sending is switched on. Read-only, changes nothing.
// Mirrors the "due" selection in app/api/outbound/run/route.ts (owned by
// another lane this round) without touching that file.
import { db } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import { firm } from "../../../../../firm.config";
import { dailyCapForMailbox } from "../../../../lib/outbound/ramp";

type DueRow = { mailbox: string | null; n: number };
type MailboxRow = { address: string; warmup_started: string | null; paused: number };

export async function GET() {
  const user = await requireUser();
  if (user instanceof Response) return user;

  const dueByMailbox = db()
    .prepare(
      `SELECT mailbox, COUNT(*) as n
       FROM outbound_messages
       WHERE status = 'queued' AND (scheduled_for IS NULL OR date(scheduled_for) <= date('now'))
       GROUP BY mailbox`
    )
    .all() as DueRow[];

  const totalDue = dueByMailbox.reduce((sum, r) => sum + r.n, 0);

  const mailboxRows = db()
    .prepare(`SELECT address, warmup_started, paused FROM mailboxes`)
    .all() as MailboxRow[];
  const mailboxByAddress = new Map(mailboxRows.map((m) => [m.address, m]));

  const today = new Date();
  const byMailbox = dueByMailbox
    .filter((r): r is DueRow & { mailbox: string } => !!r.mailbox)
    .map((r) => {
      const mailbox = mailboxByAddress.get(r.mailbox);
      const cap = mailbox ? dailyCapForMailbox(mailbox.warmup_started, today, firm.outbound, !!mailbox.paused) : 0;
      const sentToday = db()
        .prepare(
          `SELECT COUNT(*) as n FROM outbound_messages WHERE mailbox = ? AND status = 'sent' AND date(sent_at) = date('now')`
        )
        .get(r.mailbox) as { n: number };
      return {
        mailbox: r.mailbox,
        due: r.n,
        remainingToday: Math.max(0, cap - sentToday.n),
      };
    });

  const unassigned = dueByMailbox.find((r) => !r.mailbox);

  return Response.json({
    sendEnabled: process.env.OUTBOUND_SEND_ENABLED === "1",
    totalDue,
    byMailbox,
    unassignedDue: unassigned?.n ?? 0,
  });
}
