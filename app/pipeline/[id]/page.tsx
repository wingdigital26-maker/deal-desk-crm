import { notFound, redirect } from "next/navigation";
import { currentUser } from "../../lib/session";
import { db } from "../../lib/db";
import { firm } from "../../../firm.config";
import { ButtonLink } from "../../components/ui/Button";
import DealDetail from "../../components/pipeline/DealDetail";
import type { Deal, Task } from "../../components/pipeline/types";
import type { Activity } from "../../components/crm/Timeline";

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const deal = db()
    .prepare(
      `SELECT d.*, c.name AS company_name, c.domain AS company_domain
       FROM deals d JOIN companies c ON c.id = d.company_id WHERE d.id = ?`
    )
    .get(id) as Deal | undefined;
  if (!deal) notFound();

  const tasks = db()
    .prepare("SELECT * FROM tasks WHERE deal_id = ? ORDER BY (due IS NULL), due ASC")
    .all(id) as Task[];
  const timeline = db()
    .prepare(
      `SELECT activities.id, activities.kind, activities.body, activities.created_at, users.name AS user_name
       FROM activities
       LEFT JOIN users ON users.id = activities.user_id
       WHERE activities.deal_id = ? ORDER BY activities.created_at DESC, activities.id DESC`
    )
    .all(id) as Activity[];

  return (
    <div>
      <div className="mb-4">
        <ButtonLink href="/pipeline" variant="quiet" size="sm" className="!px-0">
          Back to pipeline
        </ButtonLink>
      </div>
      <DealDetail deal={deal} tasks={tasks} timeline={timeline} stages={firm.dealStages} isOwner={user.role === "owner"} />
    </div>
  );
}
