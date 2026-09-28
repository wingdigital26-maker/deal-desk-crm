import Link from "next/link";
import { notFound, redirect } from "next/navigation";
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
import BuyerPanel, { type BuyerProfile } from "../../components/buyers/BuyerPanel";
import { buyerHistory } from "../../lib/buyers";
import { otherContactsForCompany } from "../../lib/contactCompanies";
import { isFormer, linkSpan } from "../../components/crm/linkFormat";
import { displayName } from "../../components/crm/format";
import { visibleDealIds } from "../../lib/dealAccess";
import { companyConflicts } from "../../lib/conflicts";
import { BUYER_STAGE_LABELS, isBuyerStage } from "../../lib/buyerStages";

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
type DealRow = { id: number; title: string; code_name: string | null; stage: string; next_step: string | null; next_step_due: string | null };

export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const companyId = Number(id);
  const company = db().prepare("SELECT * FROM companies WHERE id = ?").get(companyId) as CompanyRow | undefined;
  if (!company) notFound();

  const contacts = db()
    .prepare(
      `SELECT contacts.id, contacts.first_name, contacts.last_name, contacts.title, contacts.email, contacts.email_status, contacts.do_not_contact, contacts.relationship, lt.last_touch
       FROM contacts
       LEFT JOIN (SELECT contact_id, MAX(created_at) AS last_touch FROM activities GROUP BY contact_id) lt ON lt.contact_id = contacts.id
       WHERE contacts.company_id = ? ORDER BY contacts.updated_at DESC`
    )
    .all(companyId) as ContactRow[];
  // People tied here through another role (a CPA on the board, a former CFO).
  const linked = otherContactsForCompany(companyId);
  // MNPI walls: only deals this user can see, here and in every panel below.
  const w = visibleDealIds(user, "id");
  const deals = db()
    .prepare(`SELECT id, title, code_name, stage, next_step, next_step_due FROM deals WHERE company_id = ? AND ${w.sql} ORDER BY updated_at DESC`)
    .all(companyId, ...w.params) as DealRow[];
  // Signals now render through the profile's "Why now" card, which applies the
  // match discipline (a headline that does not name this company is not shown).
  const profile = getCompanyProfile(companyId)!;
  const buyerProfile = (db().prepare("SELECT * FROM buyer_profiles WHERE company_id = ?").get(companyId) as BuyerProfile | undefined) ?? null;
  const shownDeals = buyerHistory(companyId, user);
  const conflicts = companyConflicts(companyId, user);
  const wa = visibleDealIds(user, "activities.deal_id", { nullable: true });
  const activities = db()
    .prepare(
      `SELECT activities.*, users.name AS user_name FROM activities
       LEFT JOIN users ON users.id = activities.user_id
       WHERE activities.company_id = ? AND ${wa.sql} ORDER BY activities.created_at DESC, activities.id DESC`
    )
    .all(companyId, ...wa.params) as Activity[];

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

      {conflicts.length > 0 && (
        <p className="card mb-6 px-4 py-3 text-sm text-[var(--ink)]" role="note">
          <span className="font-semibold">Conflicts: </span>
          {conflicts.map((c, i) => (
            <span key={`${c.sellerDeal.id}-${c.buyerDeal.id}`}>
              {i > 0 && "; "}
              seller on{" "}
              <Link href={`/pipeline/${c.sellerDeal.id}`} className="underline decoration-[var(--rule-strong)] underline-offset-2 hover:text-[var(--accent)]">
                {c.sellerDeal.label}
              </Link>{" "}
              and a buyer at {isBuyerStage(c.buyerDeal.stage) ? BUYER_STAGE_LABELS[c.buyerDeal.stage] : c.buyerDeal.stage} on{" "}
              <Link href={`/pipeline/${c.buyerDeal.id}`} className="underline decoration-[var(--rule-strong)] underline-offset-2 hover:text-[var(--accent)]">
                {c.buyerDeal.label}
              </Link>
            </span>
          ))}
          . Review with the desk owner before either process moves.
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <OwnerCard
            profile={profile}
            actions={user?.role === "owner" ? <RefreshProfileButton companyId={companyId} refreshedAt={profile.refreshedAt} demo={isDemo()} /> : undefined}
          />
          <BusinessCard profile={profile} />
          <CompanyDetail company={company} segments={firm.segments} />

          <Panel title="Contacts">
            {contacts.length === 0 && linked.length === 0 ? (
              <EmptyState
                title="No contacts yet"
                detail="Add a contact and link it to this company."
                action={<ButtonLink href={`/contacts/new?companyId=${companyId}`}>Add a contact</ButtonLink>}
              />
            ) : (
              <>
                {contacts.length > 0 && <ContactsTable rows={contacts} />}
                {linked.length > 0 && (
                  <div className={contacts.length > 0 ? "mt-5 border-t border-[var(--rule)] pt-4" : ""}>
                    <div className="label mb-2 text-[var(--ink-soft)]">Also linked here</div>
                    <ul className="divide-y divide-[var(--rule)]">
                      {linked.map((p) => (
                        <li key={p.contact_id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2 first:pt-0 last:pb-0">
                          <Link href={`/contacts/${p.contact_id}`} className="text-sm font-medium text-[var(--ink)] hover:text-[var(--accent)]">
                            {displayName(p)}
                          </Link>
                          <span className="text-sm text-[var(--ink-soft)]">
                            {[p.role ?? "No role on file", linkSpan(p.start_date, p.end_date), isFormer(p.end_date) ? "Former" : ""]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
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
                      {d.code_name ? `${d.code_name} · ` : ""}
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

          <BuyerPanel companyId={companyId} profile={buyerProfile} history={shownDeals} />

          <WhyNowCard profile={profile} />
          <HintsCard profile={profile} />
        </div>
      </div>
    </div>
  );
}
