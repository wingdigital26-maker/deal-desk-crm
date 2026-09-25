// Approval queue. Owner and principal only (page + API both enforce).
import { db } from "../../lib/db";
import { currentUser } from "../../lib/session";
import { firm } from "../../../firm.config";
import PageHeader from "../../components/crm/PageHeader";
import DataTable, { type Column } from "../../components/crm/DataTable";
import EmptyState from "../../components/crm/EmptyState";

type TemplateRow = {
  id: number;
  name: string;
  segment_id: string;
  created_by: number | null;
  updated_at: string;
};

type UserRow = { id: number; name: string };

export default async function ApprovalsPage() {
  const user = await currentUser();
  if (!user || (user.role !== "owner" && user.role !== "principal")) {
    return (
      <div className="max-w-2xl">
        <p className="text-sm text-[var(--bad)]">This page is limited to owner and principal roles.</p>
      </div>
    );
  }

  const rows = db()
    .prepare("SELECT id, name, segment_id, created_by, updated_at FROM templates WHERE status = 'pending' ORDER BY updated_at ASC")
    .all() as TemplateRow[];

  const submitters = new Map<number, string>();
  if (rows.length > 0) {
    const users = db().prepare("SELECT id, name FROM users").all() as UserRow[];
    for (const u of users) submitters.set(u.id, u.name);
  }

  const segmentLabel = (id: string) => firm.segments.find((s) => s.id === id)?.label ?? id;

  const columns: Column<TemplateRow>[] = [
    { key: "name", label: "Name", render: (t) => t.name },
    { key: "segment", label: "Segment", render: (t) => segmentLabel(t.segment_id) },
    {
      key: "submitter",
      label: "Submitted by",
      render: (t) => (t.created_by ? submitters.get(t.created_by) ?? "Unknown" : "Unknown"),
    },
    {
      key: "status",
      label: "Status",
      render: () => (
        <span className="rounded border border-[var(--warn)]/40 px-2 py-0.5 text-xs font-medium text-[var(--warn)]">
          Waiting for approval
        </span>
      ),
    },
  ];

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Approvals"
        subtitle="Pending outbound content, oldest first. Approving binds content to its exact reference."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing waiting on approval"
          detail="Content moves here once someone submits a template from the Templates page."
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowHref={(t) => `/outbound/approvals/${t.id}`} />
      )}
    </div>
  );
}
