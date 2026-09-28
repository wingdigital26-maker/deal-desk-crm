// People and Access. Owner-only: gated here and again by every /api/users route.
import { db } from "../../lib/db";
import { currentUser } from "../../lib/session";
import PageHeader from "../../components/crm/PageHeader";
import UsersApp from "../../components/admin/UsersApp";
import DealAccessPanel, { type AccessPerson } from "../../components/admin/DealAccessPanel";
import { dealAccessMode, seesAllDeals } from "../../lib/dealAccess";
import { dealDisplayName } from "../../lib/codeNames";

type PersonRow = {
  id: number;
  email: string;
  name: string;
  role: "owner" | "principal" | "member";
  disabled: number;
  last_login_at: string | null;
};

export default async function AdminUsersPage() {
  const user = await currentUser();
  if (!user || user.role !== "owner") {
    return (
      <div className="max-w-2xl">
        <p className="text-sm text-[var(--bad)]">This page is limited to the owner role.</p>
      </div>
    );
  }

  const rows = db()
    .prepare("SELECT id, email, name, role, disabled FROM users ORDER BY name ASC")
    .all() as Omit<PersonRow, "last_login_at">[];

  const lastLogins = db()
    .prepare(
      `SELECT actor_user_id AS user_id, MAX(created_at) AS at
       FROM audit_log WHERE action = 'login.success' AND actor_user_id IS NOT NULL
       GROUP BY actor_user_id`
    )
    .all() as { user_id: number; at: string }[];
  const lastLoginByUser = new Map(lastLogins.map((r) => [r.user_id, r.at]));

  const items: PersonRow[] = rows.map((r) => ({ ...r, last_login_at: lastLoginByUser.get(r.id) ?? null }));

  const compliancePrincipalCount = db()
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'principal' AND disabled = 0")
    .get() as { n: number };

  // Deal access (MNPI walls): who can see which deals, managed through deal teams.
  const allDeals = (
    db()
      .prepare("SELECT d.id, d.title, d.code_name, c.name AS company_name FROM deals d JOIN companies c ON c.id = d.company_id ORDER BY c.name COLLATE NOCASE, d.id")
      .all() as { id: number; title: string; code_name: string | null; company_name: string }[]
  ).map((d) => ({ id: d.id, label: d.code_name ? `${dealDisplayName(d)} (${d.company_name})` : `${d.company_name}: ${d.title}` }));
  const seats = db().prepare("SELECT deal_id, user_id, role FROM deal_team").all() as { deal_id: number; user_id: number; role: string }[];
  const owned = db().prepare("SELECT id, owner_user_id FROM deals WHERE owner_user_id IS NOT NULL").all() as { id: number; owner_user_id: number }[];
  const accessPeople: AccessPerson[] = rows
    .filter((r) => !r.disabled)
    .map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      seesAll: seesAllDeals(r),
      owned: owned.filter((d) => d.owner_user_id === r.id).map((d) => d.id),
      seats: seats.filter((s) => s.user_id === r.id).map((s) => ({ deal_id: s.deal_id, role: s.role })),
    }));

  return (
    <div className="max-w-4xl">
      <PageHeader title="People and access" subtitle="Who can sign in, what they can do, and when they last signed in." />
      <UsersApp
        initialItems={items}
        initialNoCompliancePrincipal={compliancePrincipalCount.n === 0}
        currentUserId={user.id}
      />
      <div className="mt-8">
        <DealAccessPanel mode={dealAccessMode()} deals={allDeals} initialPeople={accessPeople} />
      </div>
    </div>
  );
}
