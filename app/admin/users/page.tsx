// People and Access. Owner-only: gated here and again by every /api/users route.
import { db } from "../../lib/db";
import { currentUser } from "../../lib/session";
import PageHeader from "../../components/crm/PageHeader";
import UsersApp from "../../components/admin/UsersApp";

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

  return (
    <div className="max-w-4xl">
      <PageHeader title="People and access" subtitle="Who can sign in, what they can do, and when they last signed in." />
      <UsersApp
        initialItems={items}
        initialNoCompliancePrincipal={compliancePrincipalCount.n === 0}
        currentUserId={user.id}
      />
    </div>
  );
}
