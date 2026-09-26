"use client";
// Companies panel on a contact page: every company the person is tied to, the
// role there and the dates. One link is the primary company (shown as the
// word "Primary", never a dot); making another primary moves the contact's
// company everywhere else in the app too.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";
import { inputClass } from "./Field";
import CompanySearch from "../pipeline/CompanySearch";
import type { CompanyOption } from "../pipeline/types";
import type { CompanyLink } from "../../lib/contactCompanies";
import { isFormer, linkSpan } from "./linkFormat";

type Draft = { role: string; start_date: string; end_date: string };
const emptyDraft: Draft = { role: "", start_date: "", end_date: "" };

export default function ContactCompanies({ contactId, links }: { contactId: number; links: CompanyLink[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<CompanyOption | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<number | null>(null);
  const [removing, setRemoving] = useState<CompanyLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>, companyId?: number) {
    setBusy(true);
    setError(null);
    try {
      const url = `/api/contacts/${contactId}/companies${method === "DELETE" ? `?company_id=${companyId}` : ""}`;
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not save that change.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) {
      setError("Pick a company first.");
      return;
    }
    const ok = await send("POST", { company_id: picked.id, ...draft });
    if (ok) {
      setAdding(false);
      setPicked(null);
      setDraft(emptyDraft);
    }
  }

  async function saveEdit(link: CompanyLink) {
    const ok = await send("PATCH", { company_id: link.company_id, ...draft });
    if (ok) setEditing(null);
  }

  return (
    <Panel
      title="Companies"
      actions={
        !adding && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setAdding(true);
              setEditing(null);
              setDraft(emptyDraft);
              setError(null);
            }}
          >
            Add a company
          </Button>
        )
      }
    >
      {error && <p className="mb-3 text-sm text-[var(--bad)]">{error}</p>}

      {adding && (
        <form onSubmit={add} className="mb-4 space-y-3 rounded-[12px] bg-[var(--paper)] p-4">
          <CompanySearch onSelect={setPicked} placeholder="Type to search by name or domain" />
          <DraftFields draft={draft} setDraft={setDraft} idPrefix="new-link" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving..." : "Add company"}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {links.length === 0 ? (
        !adding && <p className="text-sm text-[var(--ink-faint)]">Not linked to any company yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--rule)]">
          {links.map((l) => {
            const span = linkSpan(l.start_date, l.end_date);
            return (
              <li key={l.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/companies/${l.company_id}`} className="font-medium text-[var(--ink)] hover:text-[var(--accent)]">
                        {l.company_name}
                      </Link>
                      {l.is_primary ? (
                        <span className="label rounded-full bg-[var(--tint-1)] px-2 py-0.5 text-[var(--ink)]">Primary</span>
                      ) : isFormer(l.end_date) ? (
                        <span className="label text-[var(--ink-faint)]">Former</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-sm text-[var(--ink-soft)]">
                      {[l.role ?? "No role on file", span].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  {editing !== l.company_id && (
                    <div className="flex flex-wrap gap-1">
                      {!l.is_primary && (
                        <Button size="sm" variant="quiet" disabled={busy} onClick={() => send("PATCH", { company_id: l.company_id, is_primary: true })}>
                          Make primary
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => {
                          setEditing(l.company_id);
                          setAdding(false);
                          setError(null);
                          setDraft({ role: l.role ?? "", start_date: l.start_date ?? "", end_date: l.end_date ?? "" });
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => setRemoving(l)}>
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
                {editing === l.company_id && (
                  <div className="mt-3 space-y-3 rounded-[12px] bg-[var(--paper)] p-4">
                    <DraftFields draft={draft} setDraft={setDraft} idPrefix={`link-${l.id}`} />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy} onClick={() => saveEdit(l)}>
                        {busy ? "Saving..." : "Save"}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {removing && (
        <ConfirmDialog
          titleId="remove-company-link"
          title={`Remove ${removing.company_name} from this person?`}
          detail={
            removing.is_primary
              ? "This is their primary company. After removing it they will have no primary company until you mark another one. The company itself is not touched."
              : "Only the link goes. The company and its other contacts are not touched."
          }
          confirmLabel="Remove link"
          busy={busy}
          error={error}
          onCancel={() => {
            setRemoving(null);
            setError(null);
          }}
          onConfirm={async () => {
            if (await send("DELETE", undefined, removing.company_id)) setRemoving(null);
          }}
        />
      )}
    </Panel>
  );
}

function DraftFields({ draft, setDraft, idPrefix }: { draft: Draft; setDraft: (d: Draft) => void; idPrefix: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="block text-sm font-medium text-[var(--ink)]" htmlFor={`${idPrefix}-role`}>
        Role
        <input
          id={`${idPrefix}-role`}
          className={`${inputClass} mt-1 font-normal`}
          value={draft.role}
          placeholder="Board member, CFO, advisor"
          onChange={(e) => setDraft({ ...draft, role: e.target.value })}
        />
      </label>
      <label className="block text-sm font-medium text-[var(--ink)]" htmlFor={`${idPrefix}-start`}>
        From
        <input
          id={`${idPrefix}-start`}
          type="date"
          className={`${inputClass} mt-1 font-normal`}
          value={draft.start_date}
          onChange={(e) => setDraft({ ...draft, start_date: e.target.value })}
        />
      </label>
      <label className="block text-sm font-medium text-[var(--ink)]" htmlFor={`${idPrefix}-end`}>
        To
        <input
          id={`${idPrefix}-end`}
          type="date"
          className={`${inputClass} mt-1 font-normal`}
          value={draft.end_date}
          onChange={(e) => setDraft({ ...draft, end_date: e.target.value })}
        />
      </label>
    </div>
  );
}
