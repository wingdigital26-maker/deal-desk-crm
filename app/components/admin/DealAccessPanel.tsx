"use client";
// Deal access on the People screen (MNPI walls). Shows how many deals each
// person can see and lets the owner put people on, or take them off, a deal
// team through the existing deal team API (/api/deals/:id/team), which audits
// every change. The access mode itself is read-only here: it is set in firm.config.ts.
import { useState } from "react";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";
import { TEAM_ROLES, TEAM_ROLE_LABELS, type TeamRole } from "../../lib/dealTeam";

export type AccessDeal = { id: number; label: string };
export type AccessPerson = {
  id: number;
  name: string;
  role: string;
  seesAll: boolean;
  /** Deals this person owns of record (not removable here). */
  owned: number[];
  /** Deal team seats: deal id and team role. */
  seats: { deal_id: number; role: string }[];
};

const selectClass =
  "h-[44px] min-w-0 max-w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]";

export default function DealAccessPanel({
  mode,
  deals,
  initialPeople,
}: {
  mode: "team" | "all";
  deals: AccessDeal[];
  initialPeople: AccessPerson[];
}) {
  const [people, setPeople] = useState(initialPeople);
  const [open, setOpen] = useState<number | null>(null);
  const [pick, setPick] = useState("");
  const [role, setRole] = useState<TeamRole>("execution");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = new Map(deals.map((d) => [d.id, d.label]));

  const visibleCount = (p: AccessPerson) => new Set([...p.owned, ...p.seats.map((s) => s.deal_id)]).size;

  async function call(personId: number, dealId: number, method: "POST" | "DELETE") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/team${method === "DELETE" ? `?user_id=${personId}` : ""}`, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify({ user_id: personId, role }) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not update the deal team.");
        return;
      }
      const seat = (data.items as { user_id: number; role: string }[]).find((m) => m.user_id === personId);
      setPeople((cur) =>
        cur.map((p) =>
          p.id !== personId
            ? p
            : {
                ...p,
                seats: seat
                  ? [...p.seats.filter((s) => s.deal_id !== dealId), { deal_id: dealId, role: seat.role }]
                  : p.seats.filter((s) => s.deal_id !== dealId),
              }
        )
      );
      setPick("");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Deal access">
      <p className="text-sm text-[var(--ink)]">
        Access mode: <span className="font-semibold">{mode === "team" ? "Team only" : "Everyone"}</span>
      </p>
      <p className="mt-1 text-[13px] text-[var(--ink-soft)]">
        {mode === "team"
          ? "People see a deal only when they own it or are on its deal team. Owners see every deal to run the desk, and each time an owner opens a deal they are not on, it is recorded in the audit log."
          : "Everyone who can sign in sees every deal."}{" "}
        This is set in firm.config.ts, not here.
      </p>

      <ul className="mt-4 divide-y divide-[var(--rule)]">
        {people.map((p) => {
          const count = p.seesAll ? deals.length : visibleCount(p);
          const onIds = new Set([...p.owned, ...p.seats.map((s) => s.deal_id)]);
          const addable = deals.filter((d) => !onIds.has(d.id));
          const expanded = open === p.id;
          return (
            <li key={p.id} className="py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium text-[var(--ink)]">{p.name}</span>
                  <span className="numeric ml-2 text-sm text-[var(--ink-soft)]">
                    {p.seesAll
                      ? `Sees all ${deals.length} ${deals.length === 1 ? "deal" : "deals"}${mode === "team" ? " (owner)" : ""}`
                      : `Sees ${count} of ${deals.length} ${deals.length === 1 ? "deal" : "deals"}`}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-expanded={expanded}
                  onClick={() => {
                    setOpen(expanded ? null : p.id);
                    setPick("");
                    setError(null);
                  }}
                >
                  {expanded ? "Done" : "Manage deals"}
                </Button>
              </div>

              {expanded && (
                <div className="mt-3 rounded-[12px] bg-[var(--paper)] px-3 py-3">
                  {onIds.size === 0 ? (
                    <p className="text-sm text-[var(--ink-soft)]">Not on any deal team yet.</p>
                  ) : (
                    <ul className="space-y-1">
                      {[...onIds].map((id) => {
                        const seat = p.seats.find((s) => s.deal_id === id);
                        return (
                          <li key={id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                            <span className="min-w-0 truncate text-[var(--ink)]">{label.get(id) ?? `Deal ${id}`}</span>
                            <span className="flex items-center gap-2 text-[var(--ink-soft)]">
                              {seat ? TEAM_ROLE_LABELS[seat.role as TeamRole] ?? seat.role : "Owner of record"}
                              {seat && (
                                <Button size="sm" variant="quiet" disabled={busy} onClick={() => call(p.id, id, "DELETE")}>
                                  Remove
                                </Button>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {addable.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <select aria-label={`Add ${p.name} to a deal`} value={pick} onChange={(e) => setPick(e.target.value)} className={selectClass}>
                        <option value="">Add to a deal...</option>
                        {addable.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                      <select aria-label="Team role" value={role} onChange={(e) => setRole(e.target.value as TeamRole)} className={selectClass}>
                        {TEAM_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {TEAM_ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                      <Button size="sm" disabled={!pick || busy} onClick={() => call(p.id, Number(pick), "POST")}>
                        Add
                      </Button>
                    </div>
                  )}
                  {error && <p className="mt-2 text-sm text-[var(--bad)]">{error}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
