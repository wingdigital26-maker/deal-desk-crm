"use client";
// Contacts table with row selection, the "Queue an approved email" conversion,
// and "Find email" for contacts missing one. Used on /contacts and inside
// /companies/[id].
import { useState, type ReactNode } from "react";
import Link from "next/link";
import DataTable, { type Column } from "./DataTable";
import { Button } from "../ui/Button";
import StatusLabel from "../ui/StatusLabel";
import QueueTemplatePanel from "./QueueTemplatePanel";
import FindEmailAction from "./FindEmailAction";
import { displayName, emailCheck, relativeDays } from "./format";

export type ContactRow = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  email_status?: string | null;
  do_not_contact: number;
  company_id?: number | null;
  company_name?: string | null;
  company_city?: string | null;
  company_segment_id?: string | null;
  last_touch?: string | null;
};

export default function ContactsTable({
  rows,
  showCompanyColumn = false,
  initialQueueTemplateId,
  header,
  pagination,
}: {
  rows: ContactRow[];
  showCompanyColumn?: boolean;
  initialQueueTemplateId?: number;
  /** Page header + filters, rendered in the left column so they stay beside the panel, never underneath it. */
  header?: ReactNode;
  /** Pagination controls, rendered below the table in the left column. */
  pagination?: ReactNode;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [panelOpen, setPanelOpen] = useState(false);

  function toggleRow(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(ids: number[], checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const columns: Column<ContactRow>[] = [
    { key: "name", label: "Name", render: (r) => <span className="font-medium">{displayName(r)}</span> },
    {
      key: "title",
      label: "Title",
      // Lower priority than Name/Company/Email check: hides first once the
      // queue panel takes 420px, so the columns that remain stay readable.
      className: panelOpen ? "hidden" : "hidden max-w-[160px] truncate min-[1100px]:table-cell",
      render: (r) => (
        <span className="block max-w-[160px] truncate" title={r.title ?? undefined}>
          {r.title ?? "Not set"}
        </span>
      ),
    },
    ...(showCompanyColumn
      ? [
          {
            key: "company",
            label: "Company",
            className: "max-w-[180px] truncate",
            render: (r: ContactRow) =>
              r.company_id ? (
                <Link
                  href={`/companies/${r.company_id}`}
                  className="block max-w-[180px] truncate text-[var(--ink)] hover:text-[var(--accent)]"
                  title={r.company_name ?? undefined}
                >
                  {r.company_name ?? "Not set"}
                </Link>
              ) : (
                <span className="text-[var(--ink-faint)]">Not set</span>
              ),
          } as Column<ContactRow>,
        ]
      : []),
    {
      key: "city",
      label: "City",
      className: panelOpen ? "hidden" : "hidden min-[1100px]:table-cell",
      render: (r) => r.company_city ?? "Not set",
    },
    {
      key: "email_check",
      label: "Email check",
      render: (r) => {
        const c = emailCheck(r);
        // "Accepts all mail" is the one label long enough to threaten row
        // height once the queue panel narrows this column: shorten it while
        // the panel is open, keep the full phrase otherwise.
        const label = panelOpen && c.label === "Accepts all mail" ? "Accepts all" : c.label;
        return <StatusLabel kind={c.kind}>{label}</StatusLabel>;
      },
    },
    {
      key: "last_touch",
      label: "Last touch",
      className: "numeric text-right",
      render: (r) => <span className="numeric">{relativeDays(r.last_touch)}</span>,
    },
  ];

  const selectedContacts = rows.filter((r) => selected.has(r.id));
  const noEmailSelected = selectedContacts.filter((r) => !r.email);

  return (
    <div className="min-[1100px]:flex min-[1100px]:items-start min-[1100px]:gap-6">
      <div className="min-w-0 flex-1">
        {header}

        {initialQueueTemplateId && (
          <div className="mb-3 rounded-[12px] bg-[var(--paper)] px-4 py-2 text-sm text-[var(--ink-soft)]">
            Pick the contacts to queue for this template, then confirm below.
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-[var(--paper-deep)] px-4 py-2.5">
          <span className="text-sm font-medium text-[var(--ink)]">
            {selected.size > 0 ? `${selected.size} selected` : "Select contacts to queue an approved email"}
          </span>
          <div className="flex items-center gap-2">
            {noEmailSelected.length > 0 && !panelOpen && (
              <FindEmailAction contactIds={noEmailSelected.map((c) => c.id)} />
            )}
            <Button
              size="sm"
              variant={panelOpen ? "secondary" : "accent"}
              disabled={selected.size === 0}
              onClick={() => setPanelOpen(true)}
            >
              Queue an approved email
            </Button>
          </div>
        </div>

        <DataTable
          columns={columns}
          rows={rows}
          rowHref={(r) => `/contacts/${r.id}`}
          selection={{ selectedIds: selected, onToggleRow: toggleRow, onToggleAll: toggleAll }}
        />

        {pagination}
      </div>

      {panelOpen && (
        <QueueTemplatePanel
          contacts={selectedContacts.map((c) => ({
            id: c.id,
            name: displayName(c),
            email: c.email,
            email_status: c.email_status ?? null,
            do_not_contact: c.do_not_contact,
            segmentId: c.company_segment_id ?? null,
          }))}
          initialTemplateId={initialQueueTemplateId}
          onClose={() => {
            setPanelOpen(false);
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}
