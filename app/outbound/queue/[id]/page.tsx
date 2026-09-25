// Exact rendered email for one queued/held/sent message, plus cancel.
import { notFound, redirect } from "next/navigation";
import { currentUser } from "../../../lib/session";
import { db } from "../../../lib/db";
import PageHeader from "../../../components/crm/PageHeader";
import { ButtonLink } from "../../../components/ui/Button";
import { Field } from "../../../components/crm/Field";
import { Card, queueStatusLabel, translateReason } from "../../../components/sending/ui";
import StatusLabel from "../../../components/ui/StatusLabel";
import Letter from "../../../components/ui/Letter";
import { firm } from "../../../../firm.config";

type MessageDetail = {
  id: number;
  status: "queued" | "held" | "sent" | "failed" | "cancelled";
  mailbox: string | null;
  scheduled_for: string | null;
  sent_at: string | null;
  error: string | null;
  provider_id: string | null;
  rendered_subject: string;
  rendered_body: string;
  rendered_footer: string | null;
  lint_json: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  template_name: string;
};

type LintFinding = { ruleId: string; severity: "block" | "warn"; message: string };

export default async function MessageDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const { id } = await params;
  const messageId = Number(id);
  if (!Number.isInteger(messageId)) notFound();

  const message = db()
    .prepare(
      `SELECT m.id, m.status, m.mailbox, m.scheduled_for, m.sent_at, m.error, m.provider_id,
              m.rendered_subject, m.rendered_body, m.rendered_footer, m.lint_json,
              c.first_name, c.last_name, c.email, t.name as template_name
       FROM outbound_messages m
       JOIN contacts c ON c.id = m.contact_id
       JOIN templates t ON t.id = m.template_id
       WHERE m.id = ?`
    )
    .get(messageId) as MessageDetail | undefined;

  if (!message) notFound();

  let findings: LintFinding[] = [];
  try {
    const parsed = JSON.parse(message.lint_json || "[]");
    if (Array.isArray(parsed)) findings = parsed;
  } catch {
    findings = [];
  }

  const statusLabel = queueStatusLabel(message.status, message.provider_id);

  return (
    <div>
      <PageHeader
        title={message.rendered_subject}
        subtitle={`Template: ${message.template_name}`}
        actions={<ButtonLink href="/outbound/queue" variant="secondary" size="sm">Back to queue</ButtonLink>}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Field label="Status" value={<StatusLabel kind={statusLabel.kind}>{statusLabel.text}</StatusLabel>} />
        <Field label="Mailbox" value={message.mailbox ?? undefined} />
        <Field label="Scheduled for" value={message.scheduled_for ?? undefined} />
        <Field label="Sent at" value={message.sent_at ?? undefined} />
      </div>

      {message.error && (
        <div className="card mb-6 border border-[color-mix(in_srgb,var(--bad)_35%,transparent)] px-4 py-2 text-sm text-[var(--bad)]">
          {translateReason(message.error)}
        </div>
      )}

      <div className="mb-6">
        <div className="mb-2 text-[12px] font-semibold text-[var(--ink-soft)]">
          To {message.first_name} {message.last_name} &lt;{message.email}&gt;
        </div>
        <Letter
          subject={message.rendered_subject}
          body={message.rendered_body}
          footer={message.rendered_footer ?? undefined}
          signatureLines={[firm.sender.name, firm.sender.title]}
        />
      </div>

      <Card>
        <div className="border-b border-[var(--rule)] px-4 py-3">
          <h2 className="text-sm font-medium text-[var(--ink)]">Compliance check</h2>
          <p className="mt-0.5 text-xs text-[var(--ink-soft)]">Every check run on this content, at the time it was checked.</p>
        </div>
        {findings.length === 0 ? (
          <div className="px-4 py-3">
            <StatusLabel kind="ok">Passed every check. No issues found.</StatusLabel>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--rule)]">
            {findings.map((f, i) => (
              <li key={i} className="px-4 py-3">
                <StatusLabel kind={f.severity === "block" ? "stop" : "warn"}>{f.message}</StatusLabel>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
