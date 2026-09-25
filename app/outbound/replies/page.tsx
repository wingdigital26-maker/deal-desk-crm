// Replies read back from the sending provider: reply, bounce, unsubscribe,
// auto-reply. Server component reads the db directly; the client component
// only handles the "Check for replies" trigger, the filter toggle and
// marking a row handled.
import { redirect } from "next/navigation";
import { currentUser } from "../../lib/session";
import { db } from "../../lib/db";
import { isConfigured } from "../../lib/apollo/client";
import { isInstantlyConfigured } from "../../lib/instantly/client";
import PageHeader from "../../components/crm/PageHeader";
import RepliesClient, { type ReplyRow } from "../../components/replies/RepliesClient";

type Row = {
  id: number;
  from_email: string;
  subject: string | null;
  snippet: string | null;
  kind: string;
  handled: number;
  received_at: string;
  contact_id: number | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
};

export default async function RepliesPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const rows = db()
    .prepare(
      `SELECT r.id, r.from_email, r.subject, r.snippet, r.kind, r.handled, r.received_at, r.contact_id,
              c.first_name, c.last_name, co.name as company_name
       FROM inbound_replies r
       LEFT JOIN contacts c ON c.id = r.contact_id
       LEFT JOIN companies co ON co.id = c.company_id
       ORDER BY r.received_at DESC, r.id DESC`
    )
    .all() as Row[];

  const replies: ReplyRow[] = rows.map((r) => ({
    id: r.id,
    fromEmail: r.from_email,
    fromName: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
    companyName: r.company_name,
    subject: r.subject,
    firstLine: (r.snippet || "").split(/\r?\n/)[0]?.trim() || null,
    kind: r.kind as ReplyRow["kind"],
    handled: !!r.handled,
    receivedAt: r.received_at,
    contactId: r.contact_id,
  }));

  return (
    <div>
      <PageHeader title="Replies" subtitle="What has come back from the firm's outbound, read in from the sending account." />
      <RepliesClient
        replies={replies}
        apolloConfigured={isConfigured()}
        instantlyConfigured={isInstantlyConfigured()}
        canCheckInstantly={user.role === "owner"}
      />
    </div>
  );
}
