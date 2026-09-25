// Server wrapper: loads the signed-in user and the first page of data (all
// messages, do-not-contact list), then renders the "Send what is due"
// control plus the interactive queue browser and do-not-contact panel
// underneath it. Client components take that data as props instead of
// fetching it themselves on mount.
import { redirect } from "next/navigation";
import { currentUser } from "../../lib/session";
import { db } from "../../lib/db";
import SendDueControl from "../../components/sending/SendDueControl";
import QueueClient, { type Message } from "../../components/sending/QueueClient";
import SuppressionPanel from "../../components/sending/SuppressionPanel";

export default async function QueuePage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const messages = db()
    .prepare(
      `SELECT m.id, m.status, m.mailbox, m.scheduled_for, m.sent_at, m.error, m.provider_id, m.rendered_subject,
              c.first_name, c.last_name, c.email
       FROM outbound_messages m JOIN contacts c ON c.id = m.contact_id
       ORDER BY m.id DESC LIMIT 100`
    )
    .all() as Message[];

  const counts = db().prepare(`SELECT status, COUNT(*) as n FROM outbound_messages GROUP BY status`).all() as {
    status: string;
    n: number;
  }[];

  const suppression = db()
    .prepare(`SELECT email, reason, created_at FROM suppression ORDER BY created_at DESC`)
    .all() as { email: string; reason: string; created_at: string }[];

  const dueNow = db()
    .prepare(
      `SELECT COUNT(*) as n FROM outbound_messages
       WHERE status = 'queued' AND (scheduled_for IS NULL OR date(scheduled_for) <= date('now'))`
    )
    .get() as { n: number };

  return (
    <div>
      <QueueClient
        initialMessages={messages}
        initialCounts={Object.fromEntries(counts.map((c) => [c.status, c.n]))}
      >
        <SendDueControl
          isOwner={user.role === "owner"}
          sendEnabled={process.env.OUTBOUND_SEND_ENABLED === "1"}
          initialTotalDue={dueNow.n}
        />
      </QueueClient>
      <SuppressionPanel user={user} initialEntries={suppression} />
    </div>
  );
}
