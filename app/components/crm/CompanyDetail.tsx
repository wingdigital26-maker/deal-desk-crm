"use client";
import { useState } from "react";
import { Field } from "./Field";
import CompanyForm, { type CompanyFormValues } from "./CompanyForm";
import type { Segment } from "../../../firm.config";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";

export default function CompanyDetail({ company, segments }: { company: CompanyFormValues; segments: readonly Segment[] }) {
  const [editing, setEditing] = useState(false);
  const segmentLabel = segments.find((s) => s.id === company.segment_id)?.label ?? company.segment_id;

  if (editing) {
    return (
      <Panel title="Company details">
        <CompanyForm segments={segments} initial={company} onCancel={() => setEditing(false)} />
      </Panel>
    );
  }

  return (
    <Panel
      title="Company details"
      actions={
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Domain" value={company.domain} />
        <Field label="Segment" value={segmentLabel} />
        <Field label="Industry" value={company.industry} />
        <Field label="City" value={company.city} />
        <Field label="State" value={company.state} />
        <Field label="Employees" value={company.employees ?? undefined} />
        <Field label="Revenue band" value={company.revenue_band} />
      </div>
      {company.notes && (
        <div className="mt-4 border-t border-[var(--rule)] pt-4">
          <Field label="Notes" value={<span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{company.notes}</span>} />
        </div>
      )}
    </Panel>
  );
}
