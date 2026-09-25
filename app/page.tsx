import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "./lib/session";
import { db } from "./lib/db";
import { firm } from "../firm.config";
import { formatDate, isOverdue, todayISO } from "./components/pipeline/dateUtils";
import PageHeader from "./components/crm/PageHeader";
import Panel from "./components/ui/Panel";
import StatusLabel from "./components/ui/StatusLabel";
import { ButtonLink } from "./components/ui/Button";
import { relationshipsDue } from "./lib/cadence";
import { LogTouchButton, cadenceLabel } from "./components/crm/TouchCadence";
import { displayName } from "./components/crm/format";
import { ActivityIcon, ColumnsIcon, InboxIcon, TriangleAlertIcon } from "./components/ui/icons";

export const metadata = { title: `Today | ${firm.productName}` };

type NeedRow = {
  kind: "task" | "deal";
  id: number;
  title: string;
  due: string;
  dealId: number | null;
  dealTitle: string | null;
  companyName: string | null;
};

type QuietDealRow = {
  id: number;
  title: string;
  company_name: string;
  stage: string;
  last_activity_at: string | null;
};

type ReplyRow = {
  id: number;
  from_email: string;
  subject: string | null;
  received_at: string;
  kind: "reply" | "bounce" | "unsubscribe" | "auto-reply";
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
};

function replyKindLabel(kind: ReplyRow["kind"]): { kind: "ok" | "info" | "warn" | "stop"; text: string } {
  switch (kind) {
    case "reply":
      return { kind: "ok", text: "Replied" };
    case "auto-reply":
      return { kind: "info", text: "Auto reply" };
    case "bounce":
      return { kind: "stop", text: "Bounced" };
    case "unsubscribe":
      return { kind: "warn", text: "Asked to stop" };
  }
}

type SignalRow = { id: number; title: string; kind: string; company_id: number; company_name: string; created_at: string };

function overdueDays(due: string): number {
  const then = new Date(due.slice(0, 10) + "T00:00:00");
  const now = new Date(todayISO() + "T00:00:00");
  return Math.max(1, Math.round((now.getTime() - then.getTime()) / 86400000));
}

export default async function TodayPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const today = todayISO();

  const dueTasks = db()
    .prepare(
      `SELECT t.id, t.title, t.due, t.deal_id, d.title AS deal_title, c.name AS company_name
       FROM tasks t LEFT JOIN deals d ON d.id = t.deal_id LEFT JOIN companies c ON c.id = d.company_id
       WHERE t.done = 0 AND t.due IS NOT NULL AND t.due <= ?
       ORDER BY t.due ASC`
    )
    .all(today) as { id: number; title: string; due: string; deal_id: number | null; deal_title: string | null; company_name: string | null }[];

  const dueDeals = db()
    .prepare(
      `SELECT d.id, d.title, c.name AS company_name, d.next_step, d.next_step_due
       FROM deals d JOIN companies c ON c.id = d.company_id
       WHERE d.next_step_due IS NOT NULL AND d.next_step_due <= ? AND d.stage NOT IN ('Closed', 'Passed')
       ORDER BY d.next_step_due ASC`
    )
    .all(today) as { id: number; title: string; company_name: string; next_step: string | null; next_step_due: string }[];

  const needs: NeedRow[] = [
    ...dueTasks.map((t) => ({
      kind: "task" as const,
      id: t.id,
      title: t.title,
      due: t.due,
      dealId: t.deal_id,
      dealTitle: t.deal_title,
      companyName: t.company_name,
    })),
    ...dueDeals.map((d) => ({
      kind: "deal" as const,
      id: d.id,
      title: d.next_step ?? "Next step",
      due: d.next_step_due,
      dealId: d.id,
      dealTitle: d.title,
      companyName: d.company_name,
    })),
  ].sort((a, b) => a.due.localeCompare(b.due));

  const quietDeals = db()
    .prepare(
      `SELECT d.id, d.title, c.name AS company_name, d.stage,
              (SELECT MAX(a.created_at) FROM activities a WHERE a.deal_id = d.id) AS last_activity_at
       FROM deals d JOIN companies c ON c.id = d.company_id
       WHERE d.stage NOT IN ('Closed', 'Passed')
       AND (
         ((SELECT MAX(a.created_at) FROM activities a WHERE a.deal_id = d.id) IS NULL AND d.created_at <= datetime('now', '-21 days'))
         OR (SELECT MAX(a.created_at) FROM activities a WHERE a.deal_id = d.id) <= datetime('now', '-21 days')
       )
       ORDER BY last_activity_at ASC`
    )
    .all() as QuietDealRow[];

  const dueRelationships = relationshipsDue(8);

  let replies: ReplyRow[] = [];
  let repliesUnavailable = false;
  try {
    replies = db()
      .prepare(
        `SELECT r.id, r.from_email, r.subject, r.received_at, r.kind,
                c.first_name, c.last_name, co.name AS company_name
         FROM inbound_replies r
         LEFT JOIN contacts c ON c.id = r.contact_id
         LEFT JOIN companies co ON co.id = c.company_id
         WHERE r.handled = 0 ORDER BY r.received_at DESC LIMIT 5`
      )
      .all() as ReplyRow[];
  } catch {
    repliesUnavailable = true;
  }

  const signals = db()
    .prepare(
      `SELECT s.id, s.title, s.kind, s.company_id, c.name AS company_name, s.created_at
       FROM signals s JOIN companies c ON c.id = s.company_id
       ORDER BY s.created_at DESC LIMIT 5`
    )
    .all() as SignalRow[];

  // Desk-at-a-glance counts. Cheap COUNT queries so the Today screen always
  // opens with a pulse of the desk even when nothing is due (it used to leave a
  // large empty column on quiet days).
  const openDeals = (db()
    .prepare(`SELECT COUNT(*) AS n FROM deals WHERE stage NOT IN ('Closed', 'Passed')`)
    .get() as { n: number }).n;
  let unhandledReplies = 0;
  try {
    unhandledReplies = (db()
      .prepare(`SELECT COUNT(*) AS n FROM inbound_replies WHERE handled = 0`)
      .get() as { n: number }).n;
  } catch {
    unhandledReplies = 0;
  }
  const signals7d = (db()
    .prepare(`SELECT COUNT(*) AS n FROM signals WHERE created_at >= datetime('now', '-7 days')`)
    .get() as { n: number }).n;

  const glance: { label: string; value: number; href: string; tint: string; Icon: (p: { className?: string }) => React.ReactNode }[] = [
    { label: "Open deals in the pipeline", value: openDeals, href: "/pipeline", tint: "var(--tint-1)", Icon: ColumnsIcon },
    { label: "Deals quiet 21+ days", value: quietDeals.length, href: "/pipeline", tint: "var(--tint-2)", Icon: TriangleAlertIcon },
    { label: "Replies waiting on you", value: unhandledReplies, href: "/outbound/replies", tint: "var(--tint-3)", Icon: InboxIcon },
    { label: "New signals this week", value: signals7d, href: "/sourcing/signals", tint: "var(--tint-4)", Icon: ActivityIcon },
  ];

  // Week strip + schedule (Dashboards V2 pattern): every open task and deal
  // next step due this week, Monday to Sunday. Real rows only.
  const base = new Date(today + "T00:00:00");
  const monday = new Date(base);
  monday.setDate(base.getDate() - ((base.getDay() + 6) % 7));
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
  const weekStart = iso(week[0]);
  const weekEnd = iso(week[6]);
  const weekTasks = db()
    .prepare(
      `SELECT t.id, t.title, t.due, c.name AS company_name FROM tasks t
       LEFT JOIN deals d ON d.id = t.deal_id LEFT JOIN companies c ON c.id = d.company_id
       WHERE t.done = 0 AND t.due >= ? AND t.due <= ? ORDER BY t.due`
    )
    .all(weekStart, weekEnd + "T23:59:59") as { id: number; title: string; due: string; company_name: string | null }[];
  const weekDeals = db()
    .prepare(
      `SELECT d.id, d.next_step, d.next_step_due, c.name AS company_name FROM deals d JOIN companies c ON c.id = d.company_id
       WHERE d.next_step_due >= ? AND d.next_step_due <= ? AND d.stage NOT IN ('Closed', 'Passed') ORDER BY d.next_step_due`
    )
    .all(weekStart, weekEnd + "T23:59:59") as { id: number; next_step: string | null; next_step_due: string; company_name: string }[];
  const schedule = [
    ...weekTasks.map((t) => ({ key: `t${t.id}`, title: t.title, due: t.due.slice(0, 10), who: t.company_name, href: "/tasks", kind: "Task" })),
    ...weekDeals.map((d) => ({ key: `d${d.id}`, title: d.next_step ?? "Next step", due: d.next_step_due.slice(0, 10), who: d.company_name, href: `/pipeline/${d.id}`, kind: "Deal step" })),
  ].sort((a, b) => a.due.localeCompare(b.due));
  const perDay = new Map<string, number>();
  for (const s of schedule) perDay.set(s.due, (perDay.get(s.due) ?? 0) + 1);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = user.name.split(" ")[0];
  const dateLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  return (
    <div>
      <PageHeader
        title={`Hi ${firstName}`}
        subtitle={`${greeting}. Here is your desk for ${dateLabel}.`}
        actions={<ButtonLink href="/tasks" variant="primary">Add a task</ButtonLink>}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {glance.map((g) => (
          <Link
            key={g.label}
            href={g.href}
            style={{ background: g.tint }}
            className="lift group flex min-h-[148px] flex-col justify-between rounded-[var(--radius-lg)] p-5"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-[13px] font-medium leading-snug text-[var(--ink)]">{g.label}</span>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--surface)]/80 text-[var(--ink)]">
                <g.Icon className="h-4 w-4" />
              </span>
            </div>
            <div className="display mt-4 text-[40px] font-bold leading-none tracking-tight tabular-nums text-[var(--ink)]">{g.value}</div>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="min-w-0 space-y-6">
          <div className="card p-5">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="text-[16px] font-bold text-[var(--ink)]">Weekly schedule</h2>
              <span className="text-xs text-[var(--ink-soft)]">
                {week[0].toLocaleDateString("en-US", { month: "long", year: "numeric" })}
              </span>
            </div>
            <ol className="grid grid-cols-7 gap-1.5">
              {week.map((d) => {
                const key = iso(d);
                const isToday = key === today;
                const n = perDay.get(key) ?? 0;
                return (
                  <li
                    key={key}
                    aria-current={isToday ? "date" : undefined}
                    className={`flex flex-col items-center gap-0.5 rounded-[14px] py-2.5 ${isToday ? "bg-[var(--navy)] text-white" : "bg-[var(--paper)] text-[var(--ink)]"}`}
                  >
                    <span className={`text-[11px] ${isToday ? "text-white/80" : "text-[var(--ink-soft)]"}`}>
                      {d.toLocaleDateString("en-US", { weekday: "short" })}
                    </span>
                    <span className="numeric text-[17px] font-semibold">{d.getDate()}</span>
                    <span className={`text-[10px] leading-tight ${isToday ? "text-white/80" : "text-[var(--ink-soft)]"}`}>
                      {n > 0 ? `${n} due` : " "}
                    </span>
                  </li>
                );
              })}
            </ol>
            {schedule.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--ink-soft)]">Nothing scheduled this week. Tasks and deal next steps with a due date land here.</p>
            ) : (
              <ul className="mt-4 divide-y divide-[var(--rule)]">
                {schedule.map((s) => {
                  const d = new Date(s.due + "T00:00:00");
                  const past = s.due < today;
                  return (
                    <li key={s.key}>
                      <Link href={s.href} className="flex min-h-[56px] items-center gap-3 py-2 hover:bg-[var(--paper)]">
                        <span className="flex w-12 shrink-0 flex-col items-center rounded-[12px] bg-[var(--paper)] py-1.5">
                          <span className="text-[10px] font-semibold uppercase text-[var(--ink-soft)]">{d.toLocaleDateString("en-US", { month: "short" })}</span>
                          <span className="numeric text-[15px] font-semibold text-[var(--ink)]">{d.getDate()}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-[var(--ink)]">{s.title}</span>
                          <span className="block truncate text-xs text-[var(--ink-soft)]">{s.kind}{s.who ? ` for ${s.who}` : ""}</span>
                        </span>
                        <StatusLabel kind={past ? "warn" : s.due === today ? "info" : "ok"} className="shrink-0">
                          {past ? "Overdue" : s.due === today ? "Today" : "Upcoming"}
                        </StatusLabel>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
          <h2 className="mb-3 text-[16px] font-bold text-[var(--ink)]">Needs you today</h2>
          {needs.length === 0 ? (
            <p className="card px-5 py-4 text-sm text-[var(--ink-soft)]">
              Nothing overdue and nothing due today. Tasks and deal next steps that need attention will show up here.
            </p>
          ) : (
            <ul className="card">
              {needs.map((n) => {
                const overdue = isOverdue(n.due);
                return (
                  <li
                    key={`${n.kind}-${n.id}`}
                    className="flex items-center justify-between gap-3 border-b border-[var(--rule)] px-4 py-3 text-sm last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-1">
                        <span className="min-w-0 truncate text-[var(--ink)]" title={n.title}>
                          {n.title}
                        </span>
                        {n.kind === "deal" && (
                          <span className="shrink-0 text-[var(--ink-faint)]">next step</span>
                        )}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-baseline gap-1 text-xs text-[var(--ink-soft)]">
                        <span className="min-w-0 truncate">{n.companyName ?? "No company"}</span>
                        {n.dealTitle && n.kind === "task" && (
                          <Link
                            href={`/pipeline/${n.dealId}`}
                            className="shrink-0 max-w-[45%] truncate underline decoration-[var(--rule-strong)] hover:text-[var(--ink)]"
                            title={n.dealTitle}
                          >
                            {n.dealTitle}
                          </Link>
                        )}
                        {n.kind === "deal" && n.dealId && (
                          <Link
                            href={`/pipeline/${n.dealId}`}
                            className="shrink-0 underline decoration-[var(--rule-strong)] hover:text-[var(--ink)]"
                          >
                            Open deal
                          </Link>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      {overdue ? (
                        <StatusLabel kind="warn">{`Overdue ${overdueDays(n.due)} ${overdueDays(n.due) === 1 ? "day" : "days"}`}</StatusLabel>
                      ) : (
                        <span className="numeric text-[var(--ink-soft)]">{formatDate(n.due)}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Relationships due for a touch" actions={<ButtonLink href="/contacts" variant="quiet" size="sm">Contacts</ButtonLink>}>
            {dueRelationships.length === 0 ? (
              <p className="text-sm text-[var(--ink-soft)]">
                Nobody is overdue. Set a touch reminder on any contact or referral source and they show up here when they go quiet.
              </p>
            ) : (
              <ul className="space-y-3">
                {dueRelationships.map((r) => (
                  <li key={r.id} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <Link href={`/contacts/${r.id}`} className="block truncate text-[var(--ink)] hover:underline">
                        {displayName(r)}
                      </Link>
                      <div className="mt-0.5 truncate text-xs text-[var(--ink-soft)]">
                        {r.company_name ? `${r.company_name} · ` : ""}
                        {r.days_since == null ? "never touched" : `${r.days_since} days since last touch`}
                        {" · "}
                        {cadenceLabel(r.touch_every_days).toLowerCase()}
                      </div>
                    </div>
                    <LogTouchButton contactId={r.id} companyId={r.company_id} label="Log touch" />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Going quiet" actions={<ButtonLink href="/pipeline" variant="quiet" size="sm">See all</ButtonLink>}>
            {quietDeals.length === 0 ? (
              <p className="text-sm text-[var(--ink-soft)]">Every open deal has had activity in the last 21 days.</p>
            ) : (
              <ul className="space-y-3">
                {quietDeals.slice(0, 5).map((d) => (
                  <li key={d.id} className="min-w-0 text-sm">
                    <Link href={`/pipeline/${d.id}`} className="block truncate text-[var(--ink)] hover:underline" title={d.company_name}>
                      {d.company_name}
                    </Link>
                    <div className="mt-0.5 text-xs text-[var(--ink-soft)]">
                      {d.stage}
                      {" · "}
                      {d.last_activity_at ? (
                        <span className="numeric">{Math.abs(overdueDays(d.last_activity_at.slice(0, 10)))} days quiet</span>
                      ) : (
                        "no activity logged"
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="New replies" actions={<ButtonLink href="/outbound/replies" variant="quiet" size="sm">See all</ButtonLink>}>
            {repliesUnavailable ? (
              <p className="text-sm text-[var(--ink-soft)]">Reply tracking is not set up for this workspace yet.</p>
            ) : replies.length === 0 ? (
              <p className="text-sm text-[var(--ink-soft)]">No unhandled replies. Anything that comes in will show up here.</p>
            ) : (
              <ul className="space-y-3">
                {replies.map((r) => {
                  const name = [r.first_name, r.last_name].filter(Boolean).join(" ");
                  const label = replyKindLabel(r.kind);
                  return (
                    <li key={r.id} className="min-w-0 text-sm">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[var(--ink)]" title={name || r.from_email}>
                          {name || r.from_email}
                        </span>
                        {name && r.company_name && (
                          <span className="hidden shrink-0 max-w-[35%] truncate text-[var(--ink-soft)] sm:block" title={r.company_name}>
                            &middot; {r.company_name}
                          </span>
                        )}
                        <StatusLabel kind={label.kind} className="shrink-0">{label.text}</StatusLabel>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-[var(--ink-soft)]">{r.subject ?? "No subject"}</div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="New signals" actions={<ButtonLink href="/sourcing/signals" variant="quiet" size="sm">See all</ButtonLink>}>
            {signals.length === 0 ? (
              <p className="text-sm text-[var(--ink-soft)]">No signals collected yet. The sourcing scrapers and Apollo imports feed this list.</p>
            ) : (
              <ul className="space-y-3">
                {signals.map((s) => (
                  <li key={s.id} className="min-w-0 text-sm">
                    <div className="truncate text-[var(--ink)]" title={s.company_name}>{s.company_name}</div>
                    <div className="mt-0.5 truncate text-xs text-[var(--ink-soft)] capitalize">{s.title}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
