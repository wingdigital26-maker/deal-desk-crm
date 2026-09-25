// Add mailboxes, start warmup, pause, see today's cap and the ramp
// projection. Server component: reads the db directly and passes the rows to
// a small client component that only handles the mutating form controls and
// refreshes via router.refresh() afterward, so there is no fetch-on-mount
// effect anywhere in this page.
import { redirect } from "next/navigation";
import { currentUser } from "../../lib/session";
import { db } from "../../lib/db";
import { firm } from "../../../firm.config";
import { dailyCapForMailbox, projection, mailboxesNeededFor } from "../../lib/outbound/ramp";
import PageHeader from "../../components/crm/PageHeader";
import { Card, rampStatusLabel } from "../../components/sending/ui";
import StatusLabel from "../../components/ui/StatusLabel";
import MailboxesActions, { type Mailbox } from "../../components/sending/MailboxesActions";
import { isInstantlyConfigured } from "../../lib/instantly/client";

type MailboxRow = {
  id: number;
  address: string;
  provider: string;
  warmup_started: string | null;
  paused: number;
  created_at: string;
  domain: string | null;
  daily_cap: number | null;
};

export default async function MailboxesPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const rows = db()
    .prepare(`SELECT id, address, provider, warmup_started, paused, created_at, domain, daily_cap FROM mailboxes ORDER BY id ASC`)
    .all() as MailboxRow[];

  const today = new Date();
  const mailboxes: Mailbox[] = rows.map((m) => ({
    ...m,
    todaysCap: dailyCapForMailbox(m.warmup_started, today, firm.outbound, !!m.paused, m.daily_cap),
  }));

  const projectionRows = projection(
    rows.map((m) => ({ warmupStarted: m.warmup_started, paused: !!m.paused, dailyCap: m.daily_cap })),
    firm.outbound,
    12
  );

  const weeklyTarget = firm.outbound.weeklyTarget;
  const firstMeetingWeek = projectionRows.find((w) => w.meetsTarget);
  const mailboxesNeeded = mailboxesNeededFor(weeklyTarget, firm.outbound);

  return (
    <div>
      <PageHeader
        title="Mailboxes and warmup"
        subtitle={`A mailbox safely sends up to ${firm.outbound.maxPerMailboxPerDay} a day once warmed. Reaching ${weeklyTarget.toLocaleString()} a week takes ${mailboxesNeeded} warmed mailboxes.`}
      />

      <MailboxesActions
        mailboxes={mailboxes}
        canPullInstantly={user.role === "owner" && isInstantlyConfigured()}
      />

      <Card className="mt-6 p-4">
        <h2 className="text-sm font-medium text-[var(--ink)]">Setup: shared Instantly account</h2>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          This Instantly workspace may be shared with another tenant&apos;s campaigns. &quot;Pull mailboxes
          from Instantly&quot; only imports accounts whose domain is listed in <code>INSTANTLY_ALLOWED_DOMAINS</code>, and
          the reply check only reads the firm&apos;s own campaign(s) via <code>INSTANTLY_CAMPAIGN_ID</code>; everything else in
          the workspace, including any other tenant&apos;s mailboxes and leads, is skipped and never imported. Until the firm&apos;s own
          sending domains exist, that allowlist stays empty on purpose, so nothing is pulled in. The clean long-term fix is
          to give the firm its own Instantly workspace once it is ready to send -- Instantly API keys are scoped per
          workspace, so a separate workspace isolates him completely and is the cleaner posture for his firm&apos;s
          compliance.
        </p>
      </Card>

      <Card className="mt-6 p-4">
        <h2 className="text-sm font-medium text-[var(--ink)]">Setup: forward Instantly mailboxes to your inbox</h2>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          Deal Desk never sends email itself. Instantly sends from its own mailboxes, so replies land there first. On each
          Instantly sending mailbox, add a forwarding rule in Google Workspace (Gmail settings, Forwarding) or Microsoft 365
          (Exchange admin, mail flow rule or mailbox forwarding) that forwards every message, sent and received, to your
          normal firm inbox and keeps a copy.
        </p>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">
          Why: you answer replies from your real inbox, so there is only one path that sends email, and the firm&apos;s
          email archive captures the whole conversation for its books and records.
        </p>
      </Card>

      <Card className="mt-6">
        <div className="border-b border-[var(--rule)] px-4 py-3">
          <h2 className="text-sm font-medium text-[var(--ink)]">12-week capacity projection</h2>
          <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
            {firstMeetingWeek
              ? `Reaches the ${weeklyTarget.toLocaleString()}/week target in the week of ${firstMeetingWeek.weekStart}, at current mailboxes and warmup dates.`
              : `Does not reach the ${weeklyTarget.toLocaleString()}/week target within 12 weeks at current mailboxes and warmup dates.`}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-[var(--rule)] text-left text-[12px] font-semibold text-[var(--ink-soft)]">
                <th className="px-4 py-2">Week of</th>
                <th className="px-4 py-2">Capacity</th>
                <th className="px-4 py-2">Vs target</th>
              </tr>
            </thead>
            <tbody>
              {projectionRows.map((w) => (
                <tr key={w.weekIndex} className="border-b border-[var(--rule)] last:border-0">
                  <td className="px-4 py-2 text-[var(--ink)]">{w.weekStart}</td>
                  <td className="numeric px-4 py-2 text-[var(--ink)]">{w.capacity.toLocaleString()}</td>
                  <td className="px-4 py-2">
                    {(() => {
                      const s = rampStatusLabel(w.meetsTarget);
                      return <StatusLabel kind={s.kind}>{s.text}</StatusLabel>;
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
