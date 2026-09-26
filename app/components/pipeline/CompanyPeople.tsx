"use client";
// The deal's company and everyone who works there, sorted by how well the
// banker knows them (Jack, 2026-09-26: "one company and all the contacts that
// work inside that company that my dad would know"). Set the relationship in
// one tap, add a person without leaving the deal.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";
import { inputClass } from "../crm/Field";
import { KNOWN, RELATIONSHIPS, RELATIONSHIP_LABELS, type Relationship } from "../../lib/relationship";
import type { Person } from "../../lib/companyPeople";

const selectClass =
  "h-[44px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]";

const name = (p: Pick<Person, "first_name" | "last_name">) => [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed";

export default function CompanyPeople({
  companyId,
  companyName,
  banker,
  primaryContactId,
  dealId,
  initial,
}: {
  companyId: number;
  companyName: string;
  banker: string;
  primaryContactId: number | null;
  dealId: number;
  initial: Person[];
}) {
  const router = useRouter();
  const [people, setPeople] = useState(initial);
  const [onlyKnown, setOnlyKnown] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ first_name: "", last_name: "", title: "", email: "", phone: "", relationship: "knows" as Relationship });
  const [error, setError] = useState<string | null>(null);
  const [primary, setPrimary] = useState(primaryContactId);

  const known = people.filter((p) => KNOWN.includes(p.relationship as Relationship));
  const shown = onlyKnown ? known : people;

  async function setRelationship(id: number, relationship: string) {
    const prev = people;
    setPeople((cur) => cur.map((p) => (p.id === id ? { ...p, relationship: relationship || null } : p)));
    const res = await fetch(`/api/contacts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relationship: relationship || null }),
    }).catch(() => null);
    if (!res?.ok) {
      setPeople(prev);
      setError("Could not save that.");
    }
  }

  async function makePrimary(id: number) {
    const res = await fetch(`/api/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ primary_contact_id: id }),
    }).catch(() => null);
    if (res?.ok) setPrimary(id);
    else setError("Could not set the main contact.");
  }

  async function add() {
    setError(null);
    if (!form.first_name.trim() && !form.last_name.trim()) {
      setError("Add a first or last name.");
      return;
    }
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, company_id: companyId }),
    }).catch(() => null);
    const d = await res?.json().catch(() => null);
    if (!res?.ok) {
      setError(d?.error ?? "Could not add that person.");
      return;
    }
    setForm({ first_name: "", last_name: "", title: "", email: "", phone: "", relationship: "knows" });
    setAdding(false);
    router.refresh();
    setPeople((cur) => [
      ...cur,
      { id: d.id, first_name: form.first_name || null, last_name: form.last_name || null, title: form.title || null, role: null, email: form.email || null, phone: form.phone || null, relationship: form.relationship, do_not_contact: 0, last_touch_at: null },
    ]);
  }

  return (
    <Panel
      title={
        <span>
          People at {companyName}{" "}
          <span className="text-[13px] font-medium text-[var(--ink-soft)]">
            {people.length} {people.length === 1 ? "person" : "people"}, {known.length} {banker} knows
          </span>
        </span>
      }
      actions={
        <Button size="sm" variant={adding ? "quiet" : "secondary"} onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "Add a person"}
        </Button>
      }
    >
      {adding && (
        <div className="mb-4 grid gap-2 rounded-[14px] bg-[var(--paper)] p-3 sm:grid-cols-2">
          <input aria-label="First name" placeholder="First name" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} className={inputClass} />
          <input aria-label="Last name" placeholder="Last name" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} className={inputClass} />
          <input aria-label="Title" placeholder="Title (CEO, CFO, founder)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputClass} />
          <select aria-label={`How well ${banker} knows them`} value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value as Relationship })} className={selectClass}>
            {RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {banker} {RELATIONSHIP_LABELS[r].toLowerCase()}
              </option>
            ))}
          </select>
          <input aria-label="Email" placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} />
          <input aria-label="Phone" placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputClass} />
          <div className="sm:col-span-2 flex justify-end">
            <Button size="sm" onClick={add}>
              Add to {companyName}
            </Button>
          </div>
        </div>
      )}

      {error && <div className="mb-3 text-sm text-[var(--bad)]">{error}</div>}

      {people.length === 0 ? (
        <p className="text-sm text-[var(--ink-soft)]">
          No one at {companyName} is in the CRM yet. Add the owner and anyone else {banker} knows there.
        </p>
      ) : (
        <>
          {people.length > known.length && known.length > 0 && (
            <label className="mb-2 flex min-h-[44px] items-center gap-2 text-sm text-[var(--ink-soft)]">
              <input type="checkbox" checked={onlyKnown} onChange={(e) => setOnlyKnown(e.target.checked)} />
              Only people {banker} knows
            </label>
          )}
          <ul className="divide-y divide-[var(--rule)]">
            {shown.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <Link href={`/contacts/${p.id}`} className="font-semibold text-[var(--ink)] hover:underline">
                    {name(p)}
                  </Link>
                  {primary === p.id && <span className="ml-2 text-[12px] font-semibold text-[var(--accent-deep)]">Main contact</span>}
                  <div className="truncate text-[13px] text-[var(--ink-soft)]">
                    {[p.title ?? p.role, p.email, p.phone].filter(Boolean).join(" · ") || "No title or contact details yet"}
                    {p.do_not_contact ? " · do not contact" : ""}
                  </div>
                </div>
                <select
                  aria-label={`How well ${banker} knows ${name(p)}`}
                  value={p.relationship ?? ""}
                  onChange={(e) => setRelationship(p.id, e.target.value)}
                  className={selectClass}
                >
                  <option value="">Not set</option>
                  {RELATIONSHIPS.map((r) => (
                    <option key={r} value={r}>
                      {RELATIONSHIP_LABELS[r]}
                    </option>
                  ))}
                </select>
                {primary !== p.id && (
                  <Button size="sm" variant="quiet" onClick={() => makePrimary(p.id)}>
                    Make main contact
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
