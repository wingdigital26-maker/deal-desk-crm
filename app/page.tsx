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
import { LogTouchButton } from "./components/crm/TouchCadence";
import { cadenceLabel } from "./lib/cadenceLabels";
import { displayName } from "./components/crm/format";
import { upcomingRegulatoryDates, type Filing, type ShareholderVote } from "./lib/regulatory";
import { CalendarIcon, ColumnsIcon, TriangleAlertIcon, UsersIcon } from "./components/ui/icons";
import { bankerFirstName } from "./lib/relationship";
import { attention } from "./lib/attention";
import AttentionLabel from "./components/pipeline/AttentionLabel";

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

  // Your deals and Going quiet read the same "what matters" rules as the
  // pipeline list (app/lib/attention.ts): quiet = no interaction in 21+ days.
  const openDealRows = db()
    .prepare(
      `SELECT d.id, d.title, d.stage, d.next_step, d.next_step_due, d.created_at, c.name AS company_name,
              (SELECT MAX(a.created_at) FROM activities a WHERE a.deal_id = d.id AND a.kind IN ('note','call','meeting','email-in','email-out')) AS last_interaction_at,
              (SELECT MAX(a.created_at) FROM activities a WHERE a.deal_id = d.id) AS last_activity_at,
              (SELECT COUNT(*) FROM contacts p WHERE p.company_id = d.company_id) AS people_count,
              (SELECT GROUP_CONCAT(TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) || COALESCE(' (' || p.title || ')', ''), ', ')
                 FROM contacts p WHERE p.company_id = d.company_id AND p.relationship IN ('knows-well','knows')) AS known
       FROM deals d JOIN companies c ON c.id = d.company_id
       WHERE d.stage NOT IN ('Closed', 'Passed')
       ORDER BY (d.next_step_due IS NULL), d.next_step_due, d.updated_at DESC`
    )
    .all() as (QuietDealRow & {
      next_step: string | null;
      next_step_due: string | null;
      created_at: string;
      last_interaction_at: string | null;
      people_count: number;
      known: string | null;
    })[];
  const openWithAttention = openDealRows.map((d) => ({ ...d, a: attention(d, firm.closedStages, today) }));
  const quietDeals = openWithAttention.filter((d) => d.a.quiet).sort((x, y) => (y.a.quietDays ?? 0) - (x.a.quietDays ?? 0));

  const dueRelationships = relationshipsDue(8);


  // Desk-at-a-glance counts. Cheap COUNT queries so the Today screen always
  // opens with a pulse of the desk even when nothing is due (it used to leave a
  // large empty column on quiet days).
  const openDeals = openDealRows.length;
  const bankerName = bankerFirstName();
  const glance: { label: string; value: number; href: string; tint: string; Icon: (p: { className?: string }) => React.ReactNode }[] = [
    { label: "Open deals", value: openDeals, href: "/pipeline", tint: "var(--tint-1)", Icon: ColumnsIcon },
    { label: "Deal steps due or overdue", value: needs.length, href: "#needs", tint: "var(--tint-2)", Icon: CalendarIcon },
    { label: "Deals quiet 21+ days", value: quietDeals.length, href: "/pipeline", tint: "var(--tint-3)", Icon: TriangleAlertIcon },
    { label: "People due for a touch", value: dueRelationships.length, href: "/contacts", tint: "var(--tint-4)", Icon: UsersIcon },
  ];

  // Your deals: every open deal with the people the banker knows there
  // (2026-09-26: the pipe is one company and the contacts the banker knows).
  const myDeals = openWithAttention.slice(0, 12);

  // P5: saved regulatory and shareholder-vote dates in the next 30 days on bank / FIG deals.
  const figDeals = db()
    .prepare(`SELECT d.id, c.name AS company_name FROM deals d JOIN companies c ON c.id = d.company_id WHERE d.fig_track = 1`)
    .all() as { id: number; company_name: string }[];
  const regDates = figDeals
    .flatMap((d) => {
      const filings = db().prepare("SELECT * FROM deal_regulatory_filings WHERE deal_id = ?").all(d.id) as Filing[];
      const votes = db().prepare("SELECT * FROM deal_shareholder_votes WHERE deal_id = ?").all(d.id) as ShareholderVote[];
      return upcomingRegulatoryDates(filings, votes, today, 30).map((r) => ({ ...r, dealId: d.id, company: d.company_name }));
    })
    .sort((a, b) => a.date.localeCompare(b.date));

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

      <div className="mb-5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {glance.map((g) => (
          <Link
            key={g.label}
            href={g.href}
            style={{ background: g.tint }}
            className="lift group flex min-h-[72px] items-center gap-3 rounded-[var(--radius-lg)] px-4 py-3"
          >
            <span className="display text-[30px] font-bold leading-none tracking-tight tabular-nums text-[var(--ink)]">{g.value}</span>
            <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-[var(--ink)]">{g.label}</span>
            <span className="hidden h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--surface)]/80 text-[var(--ink)] sm:grid">
              <g.Icon className="h-4 w-4" />
            </span>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="min-w-0 space-y-6">
          <Panel title="Your deals" actions={<ButtonLink href="/pipeline" variant="quiet" size="sm">Pipeline</ButtonLink>}>
            {myDeals.length === 0 ? (
              <p className="text-sm text-[var(--ink-soft)]">No open deals yet. Open one from a company page or the Pipeline.</p>
            ) : (
              <ul className="divide-y divide-[var(--rule)]">
                {myDeals.map((d) => (
                  <li key={d.id}>
                    <Link href={`/pipeline/${d.id}`} className="block py-2 hover:bg-[var(--paper)]">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-[15px] font-bold text-[var(--ink)]">{d.company_name}</span>
                        <AttentionLabel a={d.a} />
                        <span className={`ml-auto shrink-0 text-xs ${d.a.late ? "font-bold text-[var(--accent-deep)]" : "text-[var(--ink-soft)]"}`}>{d.stage}</span>
                      </div>
                      <div
                        className="mt-0.5 truncate text-[13px] text-[var(--ink-soft)]"
                        title={d.known ? `${bankerName} knows ${d.known}` : undefined}
                      >
                        {d.known ? (
                          <>
                            <span className="font-semibold text-[var(--ink)]">{bankerName} knows </span>
                            {d.known}
                          </>
                        ) : d.people_count ? (
                          `${d.people_count} ${d.people_count === 1 ? "person" : "people"} on file, none ${bankerName} knows yet`
                        ) : (
                          "No people added yet"
                        )}
                      </div>
                      {d.next_step && (
                        <div className="mt-0.5 truncate text-xs text-[var(--ink-faint)]">
                          Next: {d.next_step}
                          {d.next_step_due ? ` · ${formatDate(d.next_step_due)}` : ""}
                        </div>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <div id="needs">
          <h2 className="mb-3 text-[16px] font-bold text-[var(--ink)]">Needs you today</h2>
          {needs.length === 0 ? (
            <p className="card px-5 py-4 text-sm text-[var(--ink-soft)]">
              Nothing overdue and nothing due today. Tasks and deal next steps that need attention will show up here.
            </p>
          ) : (
            <ul className="card">
              {needs.slice(0, 6).map((n) => {
                const overdue = isOverdue(n.due);
                return (
                  <li
                    key={`${n.kind}-${n.id}`}
                    className="flex items-center justify-between gap-3 border-b border-[var(--rule)] px-4 py-2.5 text-sm last:border-0"
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
                        <StatusLabel kind="stop" icon={TriangleAlertIcon}>{`Overdue ${overdueDays(n.due)} ${overdueDays(n.due) === 1 ? "day" : "days"}`}</StatusLabel>
                      ) : (
                        <span className="numeric text-[var(--ink-soft)]">{formatDate(n.due)}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {needs.length > 6 && (
            <p className="mt-2 text-sm text-[var(--ink-soft)]">
              And {needs.length - 6} more. <Link href="/tasks" className="underline">See every task</Link>
            </p>
          )}
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-6">
          {regDates.length > 0 && (
            <Panel title="Regulatory dates">
              <ul className="space-y-3">
                {regDates.slice(0, 6).map((r) => (
                  <li key={`${r.dealId}-${r.kind}-${r.id}-${r.label}`} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <Link href={`/pipeline/${r.dealId}`} className="block truncate text-[var(--ink)] hover:underline" title={r.company}>
                        {r.company}
                      </Link>
                      <div className="mt-0.5 truncate text-xs text-[var(--ink-soft)]">{r.label}</div>
                    </div>
                    <span className="numeric shrink-0 text-[var(--ink-soft)]">{r.date === today ? "Today" : formatDate(r.date)}</span>
                  </li>
                ))}
              </ul>
              {regDates.length > 6 && <p className="mt-3 text-xs text-[var(--ink-soft)]">{regDates.length - 6} more in the next 30 days.</p>}
            </Panel>
          )}
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
                      {d.last_interaction_at ? (
                        <span className="numeric">{d.a.quietDays} days since the last interaction</span>
                      ) : (
                        <span className="numeric">no interaction logged in {d.a.quietDays} days</span>
                      )}
                    </div>
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
