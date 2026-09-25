// Templates list: by segment + status.
import { db } from "../../lib/db";
import { firm } from "../../../firm.config";
import PageHeader from "../../components/crm/PageHeader";
import DataTable, { type Column } from "../../components/crm/DataTable";
import EmptyState from "../../components/crm/EmptyState";
import NewTemplateForm from "../../components/outbound/NewTemplateForm";
import { statusLabel, STATUS_TONE } from "../../components/outbound/labels";

type TemplateRow = {
  id: number;
  name: string;
  segment_id: string;
  status: string;
  updated_at: string;
};

export default async function TemplatesPage() {
  const rows = db()
    .prepare("SELECT id, name, segment_id, status, updated_at FROM templates ORDER BY updated_at DESC")
    .all() as TemplateRow[];

  const bySegment = new Map<string, TemplateRow[]>();
  for (const r of rows) {
    const list = bySegment.get(r.segment_id) ?? [];
    list.push(r);
    bySegment.set(r.segment_id, list);
  }

  const columns: Column<TemplateRow>[] = [
    { key: "name", label: "Name", render: (t) => t.name },
    {
      key: "status",
      label: "Status",
      render: (t) => (
        <span className={`rounded border px-2 py-0.5 text-xs font-medium ${STATUS_TONE[t.status] ?? ""}`}>
          {statusLabel(t.status)}
        </span>
      ),
    },
    {
      key: "updated_at",
      label: "Last updated",
      render: (t) => new Date(t.updated_at).toLocaleString(),
    },
  ];

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Templates"
        subtitle="Outbound content. Approval is per principal and binds to the exact rendered text."
        actions={<NewTemplateForm />}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No templates yet"
          detail="Create your first outbound email template to start the approval process."
        />
      ) : (
        <div className="space-y-8">
          {firm.segments.map((segment) => {
            const list = bySegment.get(segment.id) ?? [];
            if (list.length === 0) return null;
            return (
              <div key={segment.id}>
                <h2 className="mb-2 text-[12px] font-semibold text-[var(--ink-soft)]">{segment.label}</h2>
                <DataTable columns={columns} rows={list} rowHref={(t) => `/outbound/templates/${t.id}`} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
