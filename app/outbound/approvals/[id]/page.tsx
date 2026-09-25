import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "../../../lib/db";
import { currentUser } from "../../../lib/session";
import { lintText, footerTemplate } from "../../../lib/compliance";
import { lineDiff } from "../../../lib/compliance/diff";
import { firm } from "../../../../firm.config";
import PageHeader from "../../../components/crm/PageHeader";
import Panel from "../../../components/ui/Panel";
import Letter from "../../../components/ui/Letter";
import StatusLabel from "../../../components/ui/StatusLabel";
import ApprovalActions from "../../../components/outbound/ApprovalActions";
import DiffView from "../../../components/outbound/DiffView";
import Countersignature from "../../../components/ui/Countersignature";
import { parseSqliteDate } from "../../../lib/dates";

type TemplateRow = {
  id: number;
  name: string;
  segment_id: string;
  subject: string;
  body: string;
  allowed_merge_fields: string;
  content_hash: string;
  status: string;
  created_by: number | null;
  updated_at: string;
  approved_by: number | null;
  approved_at: string | null;
  approved_by_name?: string | null;
};

type UserRow = { id: number; name: string; email: string };

type AuditRow = { detail_json: string; created_at: string; actor_label: string | null };

function humanDate(iso: string | null | undefined): string | null {
  const d = parseSqliteDate(iso);
  if (!d) return null;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user || (user.role !== "owner" && user.role !== "principal")) {
    return (
      <div className="max-w-2xl">
        <p className="text-sm text-[var(--bad)]">This page is limited to owner and principal roles.</p>
      </div>
    );
  }

  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const template = db()
    .prepare("SELECT t.*, u.name AS approved_by_name FROM templates t LEFT JOIN users u ON u.id = t.approved_by WHERE t.id = ?")
    .get(id) as TemplateRow | undefined;
  if (!template) notFound();

  const submitter = template.created_by
    ? (db().prepare("SELECT id, name, email FROM users WHERE id = ?").get(template.created_by) as UserRow | undefined)
    : undefined;

  // Most recent previously approved version of this template, read back from
  // the audit trail (each submit and approve snapshots the full content).
  // entity is recorded as "template" by the live submit/approve routes, but
  // demo seed data historically wrote the plural "templates" for the same
  // rows; accept both so the record is never lost for seeded content.
  const lastApproved = db()
    .prepare(
      "SELECT detail_json, created_at, actor_label FROM audit_log WHERE entity IN ('template', 'templates') AND entity_id = ? AND action = 'template.approve' ORDER BY created_at DESC LIMIT 1"
    )
    .get(id) as AuditRow | undefined;

  const submittedAudit = db()
    .prepare(
      "SELECT detail_json, created_at, actor_label FROM audit_log WHERE entity IN ('template', 'templates') AND entity_id = ? AND action = 'template.submit' ORDER BY created_at DESC LIMIT 1"
    )
    .get(id) as AuditRow | undefined;

  let priorSubject = "";
  let priorBody = "";
  if (lastApproved) {
    try {
      const detail = JSON.parse(lastApproved.detail_json) as { subject?: string; body?: string };
      priorSubject = detail.subject ?? "";
      priorBody = detail.body ?? "";
    } catch {
      // no-op: treat as no prior version
    }
  }

  const findings = lintText(`${template.subject}\n${template.body}`);
  const blockFindings = findings.filter((f) => f.severity === "block");
  const warnFindings = findings.filter((f) => f.severity !== "block");
  const segmentLabel = firm.segments.find((s) => s.id === template.segment_id)?.label ?? template.segment_id;

  const isSubmitter = template.created_by === user.id;
  const canApprove = user.role === "principal" && !isSubmitter && blockFindings.length === 0;
  const canReject = user.role === "owner" || user.role === "principal";

  let blockedReason: string | undefined;
  if (blockFindings.length > 0) blockedReason = "This draft must fix the items above before it can be approved.";
  else if (user.role === "principal" && isSubmitter) blockedReason = "You wrote or last edited this. A different registered principal must approve it.";
  else if (user.role === "owner") blockedReason = "Owners can send this back but only a registered principal can approve it.";

  const approverNote =
    "Only a registered principal may approve. The person who wrote or last edited this cannot approve it.";

  let personalizationFields = "none";
  try {
    const fields = JSON.parse(template.allowed_merge_fields) as string[];
    personalizationFields = fields.length
      ? fields.map((f) => f.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())).join(", ")
      : "none";
  } catch {
    personalizationFields = "none";
  }

  const submittedWhen = submittedAudit ? humanDate(submittedAudit.created_at) : null;
  const submittedBy = submitter?.name ?? "unknown";

  return (
    <div className="max-w-[720px]">
      <Link href="/outbound/approvals" className="mb-6 inline-block text-sm text-[var(--ink-soft)] underline underline-offset-2">
        Back to approvals
      </Link>

      <PageHeader
        title={template.name}
        subtitle={`${segmentLabel} · submitted by ${submittedBy}${submittedWhen ? ` on ${submittedWhen}` : ""}`}
      />

      {/* 1. The exact email as the recipient will see it, including the footer,
             and directly under it the countersignature: what the principal's
             approval will sign, or already has. */}
      <section className="mb-6">
        <Letter subject={template.subject} body={template.body} footer={footerTemplate()} />
        {template.status === "approved" ? (
          <Countersignature
            state="approved"
            approvedBy={template.approved_by_name ?? "a registered principal"}
            date={humanDate(template.approved_at)}
            reference={template.content_hash}
          />
        ) : (
          <Countersignature
            state="pending"
            submittedBy={submitter?.name ?? "unknown"}
            date={submittedAudit ? humanDate(submittedAudit.created_at) : null}
            reference={template.content_hash}
          />
        )}
        <p className="mt-3 text-center text-xs text-[var(--ink-faint)]">
          Every email ends with this footer. Changing the footer sends every approved email back for approval.
        </p>
      </section>

      {/* 2. Compliance check. */}
      <section className="mb-6">
        <h2 className="mb-3 text-[var(--ink)]">Compliance check</h2>
        {findings.length === 0 ? (
          <StatusLabel kind="ok">Nothing to fix</StatusLabel>
        ) : (
          <ul className="space-y-2">
            {blockFindings.map((f, i) => (
              <li key={`block-${i}`}>
                <StatusLabel kind="stop">
                  Must fix before submitting: {f.message} ({f.match})
                </StatusLabel>
              </li>
            ))}
            {warnFindings.map((f, i) => (
              <li key={`warn-${i}`}>
                <StatusLabel kind="warn">
                  Worth a second look: {f.message} ({f.match})
                </StatusLabel>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. What changed since the last approved version. */}
      <section className="mb-6">
        <h2 className="mb-3 text-[var(--ink)]">What changed</h2>
        {!lastApproved ? (
          <p className="text-sm text-[var(--ink-faint)]">
            This is the first version submitted for approval, so there is nothing to compare.
          </p>
        ) : (
          <div className="space-y-4">
            <DiffView label="Subject" lines={lineDiff(priorSubject, template.subject)} />
            <DiffView label="Body" lines={lineDiff(priorBody, template.body)} />
          </div>
        )}
      </section>

      {/* 4. Personalization fields (who submitted, when and the reference are
             carried by the header and the countersignature above). */}
      <section className="mb-6 text-sm text-[var(--ink-soft)]">
        <div className="flex flex-wrap gap-x-2">
          <span className="label">Personalization fields</span>
          <span>{personalizationFields}</span>
        </div>
      </section>

      {/* 5. The decision. Repeats who submitted this and when in one sentence
             so a long letter above never leaves the principal deciding
             without that fact in view. */}
      <Panel title="Decision">
        <p className="mb-4 text-sm text-[var(--ink-soft)]">
          Submitted by {submittedBy}
          {submittedWhen ? ` on ${submittedWhen}` : ""}.
        </p>
        <ApprovalActions
          templateId={template.id}
          canApprove={canApprove}
          canReject={canReject}
          blockedReason={blockedReason}
          approverNote={approverNote}
        />
      </Panel>
    </div>
  );
}
