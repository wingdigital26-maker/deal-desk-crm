"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import DeleteDealButton from "./DeleteDealButton";
import Panel from "../ui/Panel";
import StatusLabel from "../ui/StatusLabel";
import { FieldInput, inputClass } from "../crm/Field";
import EmptyState from "../crm/EmptyState";
import Timeline, { type Activity } from "../crm/Timeline";
import { formatDate, isOverdue } from "./dateUtils";
import DealEconomics from "./DealEconomics";
import DealTeam from "./DealTeam";
import DealSource from "./DealSource";
import { formatMoney, weightedFee, type StageDefaults } from "../../lib/dealMath";
import { attention } from "../../lib/attention";
import AttentionLabel from "./AttentionLabel";
import type { Deal, Task, TeamMember, UserOption } from "./types";

const SITUATIONS = [
  { value: "growth-partner", label: "Growth partner" },
  { value: "succession", label: "Succession" },
  { value: "strategic-transition", label: "Strategic transition" },
  { value: "other", label: "Other" },
];

export default function DealDetail({
  deal: initialDeal,
  tasks: initialTasks,
  timeline,
  stages,
  isOwner = false,
  cfg,
  team,
  users,
  people,
}: {
  people?: React.ReactNode;
  deal: Deal;
  tasks: Task[];
  timeline: Activity[];
  stages: readonly string[];
  isOwner?: boolean;
  cfg: StageDefaults;
  team: TeamMember[];
  users: UserOption[];
}) {
  const router = useRouter();
  const [deal, setDeal] = useState(initialDeal);
  const [title, setTitle] = useState(deal.title);
  const [situation, setSituation] = useState(deal.situation ?? "");
  const [nextStep, setNextStep] = useState(deal.next_step ?? "");
  const [nextStepDue, setNextStepDue] = useState(deal.next_step_due ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tasks, setTasks] = useState(initialTasks);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDue, setNewTaskDue] = useState("");

  const dirty =
    title.trim() !== deal.title ||
    (situation || null) !== (deal.situation ?? null) ||
    nextStep !== (deal.next_step ?? "") ||
    nextStepDue !== (deal.next_step_due ?? "");

  async function save() {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          situation: situation || null,
          next_step: nextStep,
          next_step_due: nextStepDue,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not save.");
        return;
      }
      setDeal((d) => ({ ...d, ...data.item }));
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  async function moveStage(stage: string) {
    const prev = deal.stage;
    setDeal((d) => ({ ...d, stage }));
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) throw new Error("failed");
      // The server writes a stage-change row to the timeline; pull it in.
      router.refresh();
    } catch {
      setDeal((d) => ({ ...d, stage: prev }));
      setError("Could not change stage.");
    }
  }

  async function addTask() {
    if (!newTaskTitle.trim()) return;
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTaskTitle.trim(), due: newTaskDue || undefined, deal_id: deal.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not add task.");
        return;
      }
      setTasks((t) => [data.item, ...t]);
      setNewTaskTitle("");
      setNewTaskDue("");
      // The server logs "Task added" on the deal's timeline; pull it in.
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    }
  }

  async function toggleTask(task: Task) {
    const nextDone = task.done ? 0 : 1;
    setTasks((t) => t.map((x) => (x.id === task.id ? { ...x, done: nextDone } : x)));
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: !!nextDone }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      setTasks((t) => t.map((x) => (x.id === task.id ? { ...x, done: task.done } : x)));
      setError("Could not update that task.");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-6">
        <Panel
          title={<span className="display text-xl">{deal.title}</span>}
          actions={dirty ? <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</Button> : undefined}
        >
          <div className="text-sm text-[var(--ink-soft)]">
            <Link href={`/companies/${deal.company_id}`} className="font-medium text-[var(--accent-deep)] hover:underline">
              {deal.company_name}
            </Link>
            {deal.company_domain ? ` · ${deal.company_domain}` : ""}
          </div>

          {/* Contact and interaction fields come from the server props so a
              router.refresh() (new note, new main contact) updates them. */}
          <AtAGlance
            deal={{
              ...deal,
              primary_contact_id: initialDeal.primary_contact_id,
              primary_contact_name: initialDeal.primary_contact_name,
              primary_contact_title: initialDeal.primary_contact_title,
              last_interaction_at: initialDeal.last_interaction_at,
              last_activity_at: initialDeal.last_activity_at,
            }}
            cfg={cfg}
          />

          {error && <div className="mt-2 text-sm text-[var(--bad)]">{error}</div>}

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
            <div>
            <FieldInput label="Deal title" htmlFor="deal-detail-title">
              <input id="deal-detail-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
            </FieldInput>
            </div>
            <FieldInput label="Stage" htmlFor="deal-detail-stage">
              <select
                id="deal-detail-stage"
                value={deal.stage}
                onChange={(e) => moveStage(e.target.value)}
                className={inputClass}
              >
                {stages.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </FieldInput>
            <FieldInput label="Situation" htmlFor="deal-detail-situation">
              <select
                id="deal-detail-situation"
                value={situation}
                onChange={(e) => setSituation(e.target.value)}
                className={inputClass}
              >
                <option value="">Not set</option>
                {SITUATIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </FieldInput>
            <div className="sm:col-span-2 lg:col-span-2">
            <FieldInput label="Next step" htmlFor="deal-detail-next-step">
              <input
                id="deal-detail-next-step"
                value={nextStep}
                onChange={(e) => setNextStep(e.target.value)}
                className={inputClass}
              />
            </FieldInput>
            </div>
            <FieldInput label="Due" htmlFor="deal-detail-next-step-due">
              <input
                id="deal-detail-next-step-due"
                type="date"
                value={nextStepDue}
                onChange={(e) => setNextStepDue(e.target.value)}
                className={inputClass}
              />
            </FieldInput>
          </div>
        </Panel>

        {people}

        <DealEconomics deal={deal} cfg={cfg} onSaved={(d) => setDeal((cur) => ({ ...cur, ...d }))} />

        <Panel title="Timeline">
          <Timeline
            limit={5}
            activities={timeline}
            postUrl="/api/activities"
            extra={{ deal_id: deal.id, company_id: deal.company_id }}
          />
        </Panel>

        {isOwner && (
          <div className="flex justify-end">
            <DeleteDealButton dealId={deal.id} dealTitle={deal.title} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-6">
        <Panel title="Tasks">
          <div className="mb-3 flex flex-col gap-2">
            <input
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              placeholder="New task"
              aria-label="New task title"
              className={inputClass}
            />
            <div className="flex gap-2">
              <input
                type="date"
                value={newTaskDue}
                onChange={(e) => setNewTaskDue(e.target.value)}
                aria-label="New task due date"
                className={`flex-1 ${inputClass}`}
              />
              <Button size="sm" variant="secondary" onClick={addTask}>
                Add
              </Button>
            </div>
          </div>
          {tasks.length === 0 ? (
            <EmptyState title="No tasks for this deal" detail="Add the first one above." />
          ) : (
            <ul className="space-y-2">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-2 text-sm">
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={!!t.done}
                      onChange={() => toggleTask(t)}
                      className="mt-0.5"
                      aria-label={`Mark "${t.title}" ${t.done ? "not done" : "done"}`}
                    />
                    <span className={t.done ? "text-[var(--ink-faint)] line-through" : "text-[var(--ink)]"}>{t.title}</span>
                  </div>
                  {t.due && !t.done && isOverdue(t.due) ? (
                    <StatusLabel kind="warn">Overdue</StatusLabel>
                  ) : t.due ? (
                    <span className="numeric shrink-0 text-xs text-[var(--ink-faint)]">{formatDate(t.due)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <DealTeam dealId={deal.id} initial={team} users={users} />

        <DealSource dealId={deal.id} contactId={deal.referral_contact_id ?? null} />
      </div>
    </div>
  );
}

/** One line at the top of the deal: the facts a banker checks first. */
function AtAGlance({ deal, cfg }: { deal: Deal; cfg: StageDefaults }) {
  const a = attention(deal, cfg.closedStages);
  const weighted = weightedFee(deal, cfg);
  const last = deal.last_interaction_at;
  const item = "min-w-0";
  const dt = "text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-faint)]";
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 rounded-[12px] bg-[var(--paper)] px-3.5 py-2.5 text-sm sm:flex sm:flex-wrap sm:items-start" aria-label="Deal at a glance">
      <div className={`${item} order-1 sm:order-none`}>
        <dt className={dt}>Stage</dt>
        <dd className={a.late ? "font-bold text-[var(--accent-deep)]" : a.closed ? "text-[var(--ink-soft)]" : "font-semibold text-[var(--ink)]"}>{deal.stage}</dd>
      </div>
      <div className={`${item} order-3 col-span-2 sm:order-none sm:min-w-[180px] sm:flex-1`}>
        <dt className={dt}>Next step</dt>
        <dd className="flex min-w-0 items-center gap-x-2">
          {deal.next_step ? (
            <span className="min-w-0 truncate text-[var(--ink)]" title={deal.next_step}>
              {deal.next_step}
            </span>
          ) : (
            <span className="italic text-[var(--ink-faint)]">No next step set</span>
          )}
          {a.label && a.label.kind !== "quiet" ? (
            <AttentionLabel a={a} />
          ) : deal.next_step_due ? (
            <span className="numeric whitespace-nowrap text-[var(--ink-soft)]">{formatDate(deal.next_step_due)}</span>
          ) : null}
        </dd>
      </div>
      <div className={`${item} order-4 sm:order-none`}>
        <dt className={dt}>Weighted fee</dt>
        <dd className="numeric font-semibold text-[var(--ink)]">{weighted == null ? <span className="font-normal text-[var(--ink-faint)]">No fee terms</span> : formatMoney(weighted)}</dd>
      </div>
      <div className={`${item} order-5 sm:order-none`}>
        <dt className={dt}>Main contact</dt>
        <dd className="truncate">
          {deal.primary_contact_id && deal.primary_contact_name ? (
            <Link href={`/contacts/${deal.primary_contact_id}`} className="text-[var(--accent-deep)] hover:underline" title={deal.primary_contact_title ?? undefined}>
              {deal.primary_contact_name}
            </Link>
          ) : (
            <span className="text-[var(--ink-faint)]">Not set</span>
          )}
        </dd>
      </div>
      <div className={`${item} order-2 sm:order-none`}>
        <dt className={dt}>Last interaction</dt>
        <dd className={`numeric whitespace-nowrap ${a.quiet ? "font-semibold text-[var(--warn)]" : "text-[var(--ink)]"}`}>
          {last ? formatDate(last) : <span className="text-[var(--ink-faint)]">None logged</span>}
          {a.quiet && a.quietDays != null && <span className="font-normal"> · quiet {a.quietDays} days</span>}
        </dd>
      </div>
    </dl>
  );
}
