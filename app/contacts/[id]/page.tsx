import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "../../lib/db";
import { currentUser } from "../../lib/session";
import PageHeader from "../../components/crm/PageHeader";
import ContactDetail from "../../components/crm/ContactDetail";
import DeleteContactButton from "../../components/crm/DeleteContactButton";
import Timeline, { type Activity } from "../../components/crm/Timeline";
import Panel from "../../components/ui/Panel";
import { ButtonLink } from "../../components/ui/Button";
import { getCompanyProfile, contactOwnerView } from "../../lib/profile";
import { OwnerCard, BusinessCard, WhyNowCard, FitLine, HintsCard } from "../../components/profile/ProfileCards";
import RefreshProfileButton from "../../components/profile/RefreshProfileButton";
import { isDemo } from "../../lib/demo-policy";
import ContactCompanies from "../../components/crm/ContactCompanies";
import ReferralKindSelect from "../../components/crm/ReferralKindSelect";
import { linksForContact } from "../../lib/contactCompanies";

export const dynamic = "force-dynamic";

type ContactRow = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  email_status: string | null;
  phone: string | null;
  linkedin_url: string | null;
  company_id: number | null;
  do_not_contact: number;
  source: string;
  touch_every_days: number | null;
  referral_kind: string | null;
};

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  const { id } = await params;
  const contactId = Number(id);
  const contact = db().prepare("SELECT * FROM contacts WHERE id = ?").get(contactId) as ContactRow | undefined;
  if (!contact) notFound();

  const company = contact.company_id
    ? (db().prepare("SELECT id, name, city, state, industry FROM companies WHERE id = ?").get(contact.company_id) as
        | { id: number; name: string; city: string | null; state: string | null; industry: string | null }
        | undefined)
    : undefined;
  const companies = company ? [{ id: company.id, name: company.name }] : [];
  const activities = db()
    .prepare(
      `SELECT activities.*, users.name AS user_name FROM activities
       LEFT JOIN users ON users.id = activities.user_id
       WHERE activities.contact_id = ? ORDER BY activities.created_at DESC, activities.id DESC`
    )
    .all(contactId) as Activity[];

  const links = linksForContact(contactId);
  const sourced = db()
    .prepare("SELECT id, title, stage FROM deals WHERE referral_contact_id = ? ORDER BY updated_at DESC, id DESC")
    .all(contactId) as { id: number; title: string; stage: string }[];

  const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email || "Contact";
  const profile = company ? getCompanyProfile(company.id) : null;
  const view = profile ? contactOwnerView(contact, profile) : null;

  return (
    <div>
      <PageHeader
        title={displayName}
        subtitle={company ? `${contact.title ? `${contact.title} at ` : ""}${company.name}` : contact.title ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <ButtonLink href="/contacts" variant="quiet" size="sm">
              Back to contacts
            </ButtonLink>
            {user?.role === "owner" && <DeleteContactButton contactId={contact.id} contactName={displayName} />}
          </div>
        }
      />

      {profile && (
        <div className="mb-6">
          <FitLine profile={profile} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {profile && (
            <>
              <OwnerCard
                profile={profile}
                contact={{ name: displayName, title: contact.title, linkedin_url: contact.linkedin_url, source: contact.source }}
                view={view}
                actions={user?.role === "owner" ? <RefreshProfileButton companyId={profile.companyId} refreshedAt={profile.refreshedAt} demo={isDemo()} /> : undefined}
              />
              <BusinessCard profile={profile} />
            </>
          )}
          <ContactDetail contact={contact} companyName={company?.name ?? null} companies={companies} cadence={contact.touch_every_days} />
          <ContactCompanies contactId={contactId} links={links} />
          <Panel title="Timeline">
            <Timeline activities={activities} postUrl="/api/activities" extra={{ contact_id: contactId }} />
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          {profile && <WhyNowCard profile={profile} />}
          {profile && <HintsCard profile={profile} />}
          <Panel title="Referral credit">
            <ReferralKindSelect contactId={contactId} value={contact.referral_kind} />
            {sourced.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--ink-faint)]">No deals credited to this person yet.</p>
            ) : (
              <div className="mt-4 border-t border-[var(--rule)] pt-3">
                <div className="label mb-1 text-[var(--ink-soft)]">Deals sourced ({sourced.length})</div>
                <ul className="space-y-1">
                  {sourced.map((d) => (
                    <li key={d.id} className="text-sm">
                      <Link href={`/pipeline/${d.id}`} className="text-[var(--ink)] hover:text-[var(--accent)]">
                        {d.title}
                      </Link>
                      <span className="text-[var(--ink-soft)]"> · {d.stage}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
          <Panel title="Company">
            {company ? (
              <div>
                <Link href={`/companies/${company.id}`} className="font-medium text-[var(--ink)] hover:text-[var(--accent)]">
                  {company.name}
                </Link>
                <p className="mt-1 text-sm text-[var(--ink-soft)]">
                  {[company.industry, [company.city, company.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "No further detail on file"}
                </p>
              </div>
            ) : (
              <p className="text-sm text-[var(--ink-faint)]">Not linked to a company.</p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
