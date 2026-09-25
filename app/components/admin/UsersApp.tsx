"use client";
// People and Access. Owner-only screen (the page itself and every /api/users
// route re-check the role). Lists people, lets an owner add a person, change
// role, remove/restore access, and reset a password. Every state change goes
// through the API, which audits it and never logs a password anywhere.
import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import StatusLabel from "../ui/StatusLabel";
import DataTable, { type Column } from "../crm/DataTable";
import EmptyState from "../crm/EmptyState";
import { FieldInput, inputClass } from "../crm/Field";
import { ROLE_LABEL, ROLE_OPTIONS } from "./roleLabels";
import type { Role } from "../../lib/session";

type PersonRow = {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: number;
  last_login_at: string | null;
};

function formatLastLogin(iso: string | null): React.ReactNode {
  if (!iso) return <span className="text-[var(--ink-faint)]">Never signed in</span>;
  // Stored as UTC "YYYY-MM-DD HH:MM:SS" by SQLite's datetime('now').
  const d = new Date(iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return <span className="numeric">{iso}</span>;
  return (
    <span className="numeric">
      {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
      {d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
    </span>
  );
}

export default function UsersApp({
  initialItems,
  initialNoCompliancePrincipal,
  currentUserId,
}: {
  initialItems: PersonRow[];
  initialNoCompliancePrincipal: boolean;
  currentUserId: number;
}) {
  const [items, setItems] = useState(initialItems);
  const [noCompliancePrincipal, setNoCompliancePrincipal] = useState(initialNoCompliancePrincipal);
  const [showAdd, setShowAdd] = useState(false);
  const [reveal, setReveal] = useState<{ name: string; email: string; tempPassword: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    const res = await fetch("/api/users");
    if (!res.ok) return;
    const data = await res.json();
    setItems(data.items);
    setNoCompliancePrincipal(Boolean(data.warnings?.noCompliancePrincipal));
  }

  async function handleRoleChange(person: PersonRow, role: Role) {
    setBusyId(person.id);
    setRowError(null);
    try {
      const res = await fetch(`/api/users/${person.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError({ id: person.id, message: data.error ?? "Could not change the role" });
        return;
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleDisable(person: PersonRow) {
    setBusyId(person.id);
    setRowError(null);
    try {
      const res = await fetch(`/api/users/${person.id}/disable`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError({ id: person.id, message: data.error ?? "Could not remove access" });
        return;
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleRestore(person: PersonRow) {
    setBusyId(person.id);
    setRowError(null);
    try {
      const res = await fetch(`/api/users/${person.id}/restore`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError({ id: person.id, message: data.error ?? "Could not restore access" });
        return;
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleResetPassword(person: PersonRow) {
    setBusyId(person.id);
    setRowError(null);
    try {
      const res = await fetch(`/api/users/${person.id}/reset-password`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError({ id: person.id, message: data.error ?? "Could not reset the password" });
        return;
      }
      setReveal({ name: person.name, email: person.email, tempPassword: data.tempPassword });
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<PersonRow>[] = [
    { key: "name", label: "Name", render: (r) => r.name },
    { key: "email", label: "Email", render: (r) => r.email, priority: 2, truncate: true },
    {
      key: "role",
      label: "Role",
      render: (r) => (
        <select
          className={`${inputClass} h-[44px] w-auto py-0 text-[13px]`}
          value={r.role}
          disabled={busyId === r.id}
          onChange={(e) => handleRoleChange(r, e.target.value as Role)}
          aria-label={`Role for ${r.name}`}
        >
          {ROLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: "status",
      label: "Access",
      render: (r) =>
        r.disabled ? (
          <StatusLabel kind="stop">Access removed</StatusLabel>
        ) : (
          <StatusLabel kind="ok">Active</StatusLabel>
        ),
    },
    {
      key: "last_login",
      label: "Last sign-in",
      priority: 2,
      render: (r) => formatLastLogin(r.last_login_at),
    },
    {
      key: "actions",
      label: "",
      render: (r) => (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => handleResetPassword(r)}>
            Reset password
          </Button>
          {r.disabled ? (
            <Button size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => handleRestore(r)}>
              Restore access
            </Button>
          ) : (
            <Button
              size="sm"
              variant="danger"
              disabled={busyId === r.id || r.id === currentUserId}
              onClick={() => handleDisable(r)}
            >
              Remove access
            </Button>
          )}
          {rowError?.id === r.id && <p className="w-full text-xs text-[var(--bad)]">{rowError.message}</p>}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {noCompliancePrincipal && (
        <div className="card px-4 py-3">
          <StatusLabel kind="warn">
            Nothing can be approved until a compliance principal has access.
          </StatusLabel>
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="accent" onClick={() => setShowAdd(true)}>
          Add a person
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState title="Nobody has access yet" detail="Add the first person to this workspace." />
      ) : (
        <DataTable columns={columns} rows={items} />
      )}

      {showAdd && (
        <AddPersonPanel
          onClose={() => setShowAdd(false)}
          onCreated={async (created) => {
            setShowAdd(false);
            setReveal(created);
            await refresh();
          }}
        />
      )}

      {reveal && (
        <TempPasswordReveal
          person={reveal}
          copied={copied}
          onCopy={async () => {
            try {
              await navigator.clipboard.writeText(reveal.tempPassword);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // Clipboard access can fail (permissions, non-secure context); the
              // password is still visible on screen to copy by hand.
            }
          }}
          onClose={() => {
            setReveal(null);
            setCopied(false);
          }}
        />
      )}
    </div>
  );
}

function AddPersonPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: { name: string; email: string; tempPassword: string }) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not add this person");
        return;
      }
      onCreated({ name: data.name, email: data.email, tempPassword: data.tempPassword });
    } finally {
      setSubmitting(false);
    }
  }

  // Escape cancels, same as the Cancel button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-person-title"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 py-10 md:items-center"
    >
      <form
        onSubmit={submit}
        className="card w-full max-w-md p-5"
      >
        <h2 id="add-person-title" className="display text-lg text-[var(--ink)]">Add a person</h2>
        <div className="mt-4 space-y-4">
          <FieldInput label="Name" htmlFor="add-person-name">
            <input
              id="add-person-name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
            />
          </FieldInput>
          <FieldInput label="Email" htmlFor="add-person-email">
            <input
              id="add-person-email"
              type="email"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </FieldInput>
          <FieldInput label="Role" htmlFor="add-person-role">
            <select
              id="add-person-role"
              className={inputClass}
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FieldInput>
          {error && <p className="text-sm text-[var(--bad)]">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="accent" disabled={submitting}>
            {submitting ? "Adding..." : "Add person"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function TempPasswordReveal({
  person,
  onClose,
  onCopy,
  copied,
}: {
  person: { name: string; email: string; tempPassword: string };
  onClose: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="temp-password-title"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 py-10 md:items-center"
    >
      <div className="card w-full max-w-md p-5">
        <h2 id="temp-password-title" className="display text-lg text-[var(--ink)]">Temporary password for {person.name}</h2>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">
          Share this privately. They will be asked to choose their own password the first time they sign in.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <code className="numeric flex-1 break-all rounded-[12px] bg-[var(--paper-deep)] px-3 py-2 text-sm">
            {person.tempPassword}
          </code>
          <Button variant="secondary" size="sm" onClick={onCopy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="mt-3 text-xs text-[var(--ink-faint)]">
          This password will not be shown again. Nothing else on this screen stores it.
        </p>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
