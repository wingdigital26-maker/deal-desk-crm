"use client";
// Deal team panel: who works this mandate and in what role.
import { useState } from "react";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";
import EmptyState from "../crm/EmptyState";
import { TEAM_ROLES, TEAM_ROLE_LABELS, type TeamRole } from "../../lib/dealTeam";
import type { TeamMember, UserOption } from "./types";

const selectClass =
  "h-[44px] rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]";

export default function DealTeam({ dealId, initial, users }: { dealId: number; initial: TeamMember[]; users: UserOption[] }) {
  const [team, setTeam] = useState(initial);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<TeamRole>("execution");
  const [error, setError] = useState<string | null>(null);
  const available = users.filter((u) => !team.some((m) => m.user_id === u.id));

  async function call(method: string, body?: object, query = "") {
    setError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/team${query}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not update the team.");
        return;
      }
      setTeam(data.items);
    } catch {
      setError("Could not reach the server.");
    }
  }

  return (
    <Panel title="Deal team">
      {team.length === 0 ? (
        <EmptyState title="No one on the team yet" detail="Add the lead banker and whoever else works this mandate." />
      ) : (
        <ul className="mb-3 space-y-2">
          {team.map((m) => (
            <li key={m.user_id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium text-[var(--ink)]">{m.name}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                <select
                  aria-label={`Role for ${m.name}`}
                  value={m.role}
                  onChange={(e) => call("PATCH", { user_id: m.user_id, role: e.target.value })}
                  className={selectClass}
                >
                  {TEAM_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {TEAM_ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="quiet" onClick={() => call("DELETE", undefined, `?user_id=${m.user_id}`)} aria-label={`Remove ${m.name}`}>
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="mb-2 text-sm text-[var(--bad)]">{error}</div>}
      {available.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--rule)] pt-3">
          <select aria-label="Person to add" value={userId} onChange={(e) => setUserId(e.target.value)} className={`${selectClass} min-w-0 flex-1`}>
            <option value="">Add a person</option>
            {available.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as TeamRole)} className={selectClass}>
            {TEAM_ROLES.map((r) => (
              <option key={r} value={r}>
                {TEAM_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!userId}
            onClick={async () => {
              await call("POST", { user_id: Number(userId), role });
              setUserId("");
            }}
          >
            Add
          </Button>
        </div>
      )}
    </Panel>
  );
}
