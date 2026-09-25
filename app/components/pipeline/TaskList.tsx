"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PageHeader from "../crm/PageHeader";
import EmptyState from "../crm/EmptyState";
import { Button } from "../ui/Button";
import StatusLabel from "../ui/StatusLabel";
import { inputClass } from "../crm/Field";
import DealSearch from "./DealSearch";
import { formatDate, isOverdue, isThisWeek, isToday } from "./dateUtils";
import type { DealOption, Task } from "./types";

type Group = "Overdue" | "Today" | "This week" | "Later" | "No date";

function groupOf(task: Task): Group {
  if (!task.due) return "No date";
  if (isOverdue(task.due)) return "Overdue";
  if (isToday(task.due)) return "Today";
  if (isThisWeek(task.due)) return "This week";
  return "Later";
}

const GROUP_ORDER: Group[] = ["Overdue", "Today", "This week", "Later", "No date"];

export default function TaskList() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newDeal, setNewDeal] = useState<DealOption | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDue, setEditDue] = useState("");

  useEffect(() => {
    fetch("/api/tasks")
      .then((res) => res.json())
      .then((data) => setTasks(Array.isArray(data.items) ? data.items : []))
      .catch(() => setError("Could not load tasks."));
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<Group, Task[]>();
    for (const g of GROUP_ORDER) map.set(g, []);
    for (const t of tasks ?? []) {
      if (t.done && !showDone) continue;
      map.get(groupOf(t))!.push(t);
    }
    return map;
  }, [tasks, showDone]);

  async function addTask() {
    if (!newTitle.trim()) return;
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim(), due: newDue || undefined, deal_id: newDeal?.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not add task.");
        return;
      }
      setTasks((t) => [{ ...data.item, deal_title: newDeal?.title ?? null }, ...(t ?? [])]);
      setNewTitle("");
      setNewDue("");
      setNewDeal(null);
    } catch {
      setError("Could not reach the server.");
    }
  }

  async function toggleDone(task: Task) {
    const nextDone = task.done ? 0 : 1;
    setTasks((t) => (t ? t.map((x) => (x.id === task.id ? { ...x, done: nextDone } : x)) : t));
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: !!nextDone }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      setTasks((t) => (t ? t.map((x) => (x.id === task.id ? { ...x, done: task.done } : x)) : t));
      setError("Could not update that task.");
    }
  }

  function startEdit(task: Task) {
    setEditingId(task.id);
    setEditTitle(task.title);
    setEditDue(task.due ?? "");
  }

  async function saveEdit(task: Task) {
    const prev = task;
    setTasks((t) => (t ? t.map((x) => (x.id === task.id ? { ...x, title: editTitle, due: editDue || null } : x)) : t));
    setEditingId(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: editTitle.trim(), due: editDue || null }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      setTasks((t) => (t ? t.map((x) => (x.id === task.id ? prev : x)) : t));
      setError("Could not save that edit.");
    }
  }

  if (error && !tasks) return <div className="text-sm text-[var(--bad)]">{error}</div>;
  if (!tasks) return <div className="text-sm text-[var(--ink-faint)]">Loading tasks...</div>;

  return (
    <div>
      <PageHeader title="Tasks" subtitle="Everything open, grouped by when it is due." />

      <div className="card mb-6 space-y-3 p-4">
        <div className="flex flex-col items-end gap-2 sm:flex-row">
          <label className="flex-1">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Task title</span>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className={inputClass}
              onKeyDown={(e) => e.key === "Enter" && addTask()}
            />
          </label>
          <label>
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Due date</span>
            <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} className={inputClass} />
          </label>
          <Button variant="primary" onClick={addTask}>Add task</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:max-w-sm">
          <div className="flex-1">
            <label htmlFor="task-deal" className="mb-1 block text-sm font-medium text-[var(--ink)]">Attach to a deal (optional)</label>
            <DealSearch id="task-deal" onSelect={setNewDeal} placeholder="Search deals" />
          </div>
          {newDeal && (
            <span className="flex items-center gap-1 rounded-[12px] bg-[var(--paper)] px-2 py-1 text-xs text-[var(--ink-soft)]">
              {newDeal.title}
              <button
                type="button"
                onClick={() => setNewDeal(null)}
                aria-label="Remove attached deal"
                className="text-[var(--ink-faint)] hover:text-[var(--ink)]"
              >
                x
              </button>
            </span>
          )}
        </div>
      </div>

      <label className="mb-4 flex items-center gap-2 text-sm text-[var(--ink-soft)]">
        <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
        Show completed
      </label>

      {error && <div className="mb-3 text-sm text-[var(--bad)]">{error}</div>}

      {GROUP_ORDER.map((group) => {
        const items = grouped.get(group) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={group} className="mb-6">
            <h2 className="mb-2 text-[15px] font-semibold text-[var(--ink)]">
              {group} <span className="numeric text-[var(--ink-faint)]">({items.length})</span>
            </h2>
            <ul className="card divide-y divide-[var(--rule)]">
              {items.map((t) => (
                <li key={t.id} className="flex min-h-[44px] items-center gap-3 px-3.5 py-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={!!t.done}
                    onChange={() => toggleDone(t)}
                    aria-label={`Mark "${t.title}" ${t.done ? "not done" : "done"}`}
                  />
                  {editingId === t.id ? (
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className={inputClass}
                      />
                      <input
                        type="date"
                        value={editDue}
                        onChange={(e) => setEditDue(e.target.value)}
                        className={inputClass}
                      />
                      <Button variant="quiet" size="sm" onClick={() => saveEdit(t)}>
                        Save
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <button onClick={() => startEdit(t)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <span className="min-w-0 flex-1 truncate" title={t.title}>
                        <span className={t.done ? "text-[var(--ink-faint)] line-through" : "text-[var(--ink)]"}>{t.title}</span>
                      </span>
                      {t.deal_id && t.deal_title && (
                        <Link
                          href={`/pipeline/${t.deal_id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="hidden shrink-0 max-w-[35%] truncate text-xs text-[var(--ink-soft)] underline sm:block"
                          title={t.deal_title}
                        >
                          {t.deal_title}
                        </Link>
                      )}
                      {t.due && (
                        isOverdue(t.due) && !t.done ? (
                          <StatusLabel kind="warn" className="shrink-0">Overdue</StatusLabel>
                        ) : (
                          <span className="numeric shrink-0 text-xs text-[var(--ink-faint)]">{formatDate(t.due)}</span>
                        )
                      )}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {[...grouped.values()].every((g) => g.length === 0) && (
        <EmptyState title="No open tasks" detail="Add one above, or attach a task from a deal's page." />
      )}
    </div>
  );
}
