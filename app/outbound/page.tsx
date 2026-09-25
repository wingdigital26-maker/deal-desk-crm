// Outbound overview: the honest control room. This week's sendable capacity
// vs the weekly goal, a week-by-week ramp table (when the goal is reached and
// how many mailboxes that takes), queue counts by state, and every held
// message with its reason in plain English. Server component; reads the db
// directly (same process, no network hop) the way other dashboard-style
// pages in this app do.
import Link from "next/link";
import { currentUser } from "../lib/session";
import { redirect } from "next/navigation";
import { db } from "../lib/db";
import { firm } from "../../firm.config";
import { weeklyCapacity, mailboxesNeededFor, projection } from "../lib/outbound/ramp";
import PageHeader from "../components/crm/PageHeader";
import { ButtonLink } from "../components/ui/Button";
import EmptyState from "../components/crm/EmptyState";
import DataTable, { type Column } from "../components/crm/DataTable";
import { Card, translateReasons } from "../components/sending/ui";
import StatusLabel from "../components/ui/StatusLabel";
import { CircleSlashIcon } from "../components/ui/icons";

type MailboxRow = { warmup_started: string | null; paused: number };
type HeldMessage = {
  id: number;
  rendered_subject: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  detail_json: string;
};
type WeekRow = { id: string; weekStart: string; capacity: number; meetsTarget: boolean; short: number };

// The "sending is off" line is a stop condition worth noticing, but it should
// not open the page as a wall of red text: only the icon carries --bad, the
// words stay in ordinary ink.
function QuietStopLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--ink)]">
      <CircleSlashIcon className="shrink-0 text-[var(--bad)]" />
      <span>{children}</span>
    </span>
  );
}

function weekLabel(iso: string): string {
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return `Week of ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export default async function OutboundOverviewPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const mailboxes = db().prepare(`SELECT warmup_started, paused FROM mailboxes`).all() as MailboxRow[];
  const capacityThisWeek = weeklyCapacity(
    mailboxes.map((m) => ({ warmupStarted: m.warmup_started, paused: !!m.paused })),
    new Date(),
    firm.outbound
  );
  const mailboxesNeeded = mailboxesNeededFor(firm.outbound.weeklyTarget, firm.outbound);
  const activeMailboxCount = mailboxes.filter((m) => !m.paused).length;

  const weeks = projection(
    mailboxes.map((m) => ({ warmupStarted: m.warmup_started, paused: !!m.paused })),
    firm.outbound,
    12
  );
  const firstMeetingIndex = weeks.findIndex((w) => w.meetsTarget);
  const allWeekRows: WeekRow[] = weeks.map((w) => ({
    ...w,
    id: w.weekStart,
    short: Math.max(firm.outbound.weeklyTarget - w.capacity, 0),
  }));
  // Show the first 8 weeks, plus the first week that reaches the goal if it
  // lands later than that, so the table proves the ramp without 12 rows of noise.
  const weekRows: WeekRow[] =
    firstMeetingIndex >= 8 ? [...allWeekRows.slice(0, 8), allWeekRows[firstMeetingIndex]] : allWeekRows.slice(0, 8);

  // Steady-state capacity once every active mailbox has finished warming up,
  // derived from the same config the ramp math uses (never hardcoded).
  const fullRampCapacity = activeMailboxCount * firm.outbound.maxPerMailboxPerDay * firm.outbound.sendDays.length;
  const additionalMailboxesNeeded = Math.max(mailboxesNeeded - activeMailboxCount, 0);
  const rampSentence =
    additionalMailboxesNeeded > 0
      ? `With ${activeMailboxCount} mailbox${activeMailboxCount === 1 ? "" : "es"} this tops out at ${fullRampCapacity.toLocaleString()} a week. The goal needs ${mailboxesNeeded} at full volume: add ${additionalMailboxesNeeded} more and start ${additionalMailboxesNeeded === 1 ? "its" : "their"} warmup.`
      : `With ${activeMailboxCount} mailbox${activeMailboxCount === 1 ? "" : "es"} this tops out at ${fullRampCapacity.toLocaleString()} a week, above the ${firm.outbound.weeklyTarget.toLocaleString()}/week goal.`;

  const counts = db().prepare(`SELECT status, COUNT(*) as n FROM outbound_messages GROUP BY status`).all() as {
    status: string;
    n: number;
  }[];
  const countByStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));

  const held = db()
    .prepare(
      `SELECT m.id, m.rendered_subject, c.first_name, c.last_name, c.email,
              (SELECT detail_json FROM audit_log a WHERE a.entity = 'outbound_message' AND a.entity_id = m.id
               AND a.action = 'message.block' ORDER BY a.id DESC LIMIT 1) as detail_json
       FROM outbound_messages m JOIN contacts c ON c.id = m.contact_id
       WHERE m.status = 'held'
       ORDER BY m.id DESC LIMIT 25`
    )
    .all() as HeldMessage[];

  const sendEnabled = process.env.OUTBOUND_SEND_ENABLED === "1";

  const anyWeekMeetsTarget = weekRows.some((w) => w.meetsTarget);
  const weekTableColumns: Column<WeekRow>[] = [
    { key: "week", label: "Week", render: (w) => weekLabel(w.weekStart) },
    {
      key: "capacity",
      label: "Capacity",
      className: "text-right",
      render: (w) => <span className="numeric">{w.capacity.toLocaleString()}</span>,
    },
    {
      key: "short",
      label: "Short of goal by",
      className: "text-right",
      render: (w) => <span className="numeric">{w.meetsTarget ? "" : w.short.toLocaleString()}</span>,
    },
    // Only worth a column once at least one row actually reaches the goal;
    // otherwise it is a header sitting over an entirely empty column.
    ...(anyWeekMeetsTarget
      ? [
          {
            key: "vs",
            label: "Status",
            render: (w: WeekRow) => (w.meetsTarget ? <StatusLabel kind="ok">Reaches the goal</StatusLabel> : null),
          } as Column<WeekRow>,
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title="Outbound"
        subtitle="Weekly capacity, queue health and every held message, in plain numbers."
        actions={
          <ButtonLink href="/outbound/mailboxes" variant="secondary" size="sm">
            Manage mailboxes
          </ButtonLink>
        }
      />

      <Card className="mb-6 px-4 py-3">
        <p className="text-sm text-[var(--ink)]">
          {sendEnabled ? (
            <StatusLabel kind="ok">Yes. Sending is switched on for this workspace.</StatusLabel>
          ) : (
            <QuietStopLabel>
              Sending is switched off for this workspace. Messages are checked and recorded but nothing leaves.
            </QuietStopLabel>
          )}
        </p>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">
          Every send still requires principal-approved content bound to its approval reference, re-checked at send
          time.
        </p>
      </Card>

      <Card className="mb-6 px-4 py-3">
        <p className="text-sm text-[var(--ink)]">
          This week: <span className="numeric font-medium">{capacityThisWeek.toLocaleString()}</span> of the{" "}
          <span className="numeric font-medium">{firm.outbound.weeklyTarget.toLocaleString()}</span> weekly goal.{" "}
          {activeMailboxCount === 0
            ? "No mailboxes are warming yet."
            : `${activeMailboxCount} mailbox${activeMailboxCount === 1 ? "" : "es"} active, ${mailboxesNeeded} needed at full ramp.`}
        </p>
        {mailboxes.length === 0 && (
          <p className="mt-2 text-sm text-[var(--ink-soft)]">
            <Link href="/outbound/mailboxes" className="text-[var(--accent)] underline underline-offset-2">
              Add a mailbox
            </Link>{" "}
            to start building toward the goal.
          </p>
        )}
      </Card>

      {mailboxes.length === 0 ? (
        <EmptyState
          title="No mailboxes yet, so there is no sending capacity"
          detail="Add a mailbox and start its warmup clock to begin building toward the weekly goal."
          action={<ButtonLink href="/outbound/mailboxes">Add a mailbox</ButtonLink>}
        />
      ) : (
        <Card className="mb-6">
          <div className="border-b border-[var(--rule)] px-4 py-3">
            <h2 className="text-sm font-medium text-[var(--ink)]">12-week ramp</h2>
            <p className="mt-0.5 text-xs text-[var(--ink-soft)]">{rampSentence}</p>
          </div>
          <DataTable columns={weekTableColumns} rows={weekRows} />
        </Card>
      )}

      <Card>
        <div className="border-b border-[var(--rule)] px-4 py-3">
          <h2 className="text-sm font-medium text-[var(--ink)]">What needs attention</h2>
          <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
            Held at send-time verification. Nothing here has been sent.
          </p>
        </div>
        {held.length === 0 ? (
          <p className="px-4 py-6 text-sm text-[var(--ink-soft)]">Nothing is held right now.</p>
        ) : (
          <ul className="divide-y divide-[var(--rule)]">
            {held.map((m) => {
              let reasons: string[] = [];
              try {
                const detail = JSON.parse(m.detail_json || "{}");
                reasons = translateReasons(Array.isArray(detail.reasons) ? detail.reasons : []);
              } catch {
                reasons = [];
              }
              return (
                <li key={m.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <Link href={`/outbound/queue/${m.id}`} className="text-sm font-medium text-[var(--ink)] hover:underline">
                        {m.rendered_subject}
                      </Link>
                      <div className="text-xs text-[var(--ink-soft)]">
                        {m.first_name} {m.last_name} &lt;{m.email}&gt;
                      </div>
                    </div>
                    <StatusLabel kind="warn">Held</StatusLabel>
                  </div>
                  {reasons.length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-[var(--ink-soft)]">
                      {reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p className="mt-4 text-xs text-[var(--ink-soft)]">
        In the{" "}
        <Link href="/outbound/queue" className="text-[var(--ink)] underline underline-offset-2">
          queue
        </Link>
        : <span className="numeric">{countByStatus.queued ?? 0}</span> queued, {" "}
        <span className="numeric">{countByStatus.held ?? 0}</span> held,{" "}
        <span className="numeric">{countByStatus.sent ?? 0}</span> sent,{" "}
        <span className="numeric">{countByStatus.failed ?? 0}</span> failed,{" "}
        <span className="numeric">{countByStatus.cancelled ?? 0}</span> cancelled.
      </p>
    </div>
  );
}
