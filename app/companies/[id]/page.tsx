import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "../../lib/db";
import { firm } from "../../../firm.config";
import PageHeader from "../../components/crm/PageHeader";
import CompanyDetail from "../../components/crm/CompanyDetail";
import Timeline, { type Activity } from "../../components/crm/Timeline";
import EmptyState from "../../components/crm/EmptyState";
import ContactsTable from "../../components/crm/ContactsTable";
import CreateDealButton from "../../components/crm/CreateDealButton";
import Panel from "../../components/ui/Panel";
import { ButtonLink } from "../../components/ui/Button";
import { currentUser } from "../../lib/session";
import { getCompanyProfile } from "../../lib/profile";
import { OwnerCard, BusinessCard, WhyNowCard, FitLine, HintsCard } from "../../components/profile/ProfileCards";
import RefreshProfileButton from "../../components/profile/RefreshProfileButton";
import { isDemo } from "../../lib/demo-policy";

export const dynamic = "force-dynamic";

type CompanyRow = {
  id: number;
  name: string;
  domain: string | null;
  segment_id: string;
  industry: string | null;
  city: string | null;
  state: string | null;
  employees: number | null;
  revenue_band: string | null;
  notes: string | null;
};

type ContactRow = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  email_status: string | null;
  do_not_contact: number;
  last_touch?: string | null;
};
type DealRow = { id: number; title: string; stage: string; next_step: string | null; next_step_due: string | null };

export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const companyId = Number(id);
  const company = db().prepare("SELECT * FROM companies WHERE id = ?").get(companyId) as CompanyRow | undefined;
  if (!company) notFound();

  const contacts = db()
    .prepare(
      `SELECT contacts.id, contacts.first_name, contacts.last_name, contacts.title, contacts.email, contacts.email_status, contacts.do_not_contact, lt.last_touch
       FROM contacts
       LEFT JOIN (SELECT contact_id, MAX(created_at) AS last_touch FROM activities GROUP BY contact_id) lt ON lt.contact_id = contacts.id
       WHERE contacts.company_id = ? ORDER BY contacts.updated_at DESC`
    )
    .all(companyId) as ContactRow[];
  const deals = db()
    .prepare("SELECT id, title, stage, next_step, next_step_due FROM deals WHERE company_id = ? ORDER BY updated_at DESC")
    .all(companyId) as DealRow[];
  // Signals now render through the profile's "Why now" card, which applies the
  // match discipline (a headline that does not name this company is not shown).
  const profile = getCompanyProfile(companyId)!;
  const user = await currentUser();
  const activities = db()
    .prepare(
      `SELECT activities.*, users.name AS user_name FROM activities
       LEFT JOIN users ON users.id = activities.user_id
       WHERE activities.company_id = ? ORDER BY activities.created_at DESC, activities.id DESC`
    )
    .all(companyId) as Activity[];

  return (
    <div>
      <PageHeader
        title={company.name}
        subtitle={company.domain ?? undefined}
        actions={
          <ButtonLink href="/companies" variant="quiet" size="sm">
            Back to companies
          </ButtonLink>
        }
      />

      <div className="mb-6">
        <FitLine profile={profile} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <OwnerCard
            profile={profile}
            actions={user?.role === "owner" ? <RefreshProfileButton companyId={companyId} refreshedAt={profile.refreshedAt} demo={isDemo()} /> : undefined}
          />
          <BusinessCard profile={profile} />
          <CompanyDetail company={company} segments={firm.segments} />

          <Panel title="Contacts">
            {contacts.length === 0 ? (
              <EmptyState
                title="No contacts yet"
                detail="Add a contact and link it to this company."
                action={<ButtonLink href={`/contacts/new?companyId=${companyId}`}>Add a contact</ButtonLink>}
              />
            ) : (
              <ContactsTable rows={contacts} />
            )}
          </Panel>

          <Panel title="Timeline">
            <Timeline activities={activities} postUrl="/api/activities" extra={{ company_id: companyId }} />
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title="Deals">
            {deals.length === 0 ? (
              <EmptyState
                title="No deals yet"
                detail="Open a deal for this company and it will show up here and on the Pipeline."
                action={<CreateDealButton companyId={companyId} companyName={company.name} />}
              />
            ) : (
              <ul className="divide-y divide-[var(--rule)]">
                {deals.map((d) => (
                  <li key={d.id} className="py-2.5 first:pt-0 last:pb-0">
                    <Link href={`/pipeline/${d.id}`} className="text-sm font-medium text-[var(--ink)] hover:text-[var(--accent)]">
                      {d.title}
                    </Link>
                    <div className="text-xs text-[var(--ink-soft)]">
                      {d.stage}
                      {d.next_step ? ` · Next: ${d.next_step}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <WhyNowCard profile={profile} />
          <HintsCard profile={profile} />
        </div>
      </div>
    </div>
  );
}
