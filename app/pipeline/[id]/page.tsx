import { notFound, redirect } from "next/navigation";
import { currentUser } from "../../lib/session";
import { db } from "../../lib/db";
import { firm } from "../../../firm.config";
import { ButtonLink } from "../../components/ui/Button";
import DealDetail from "../../components/pipeline/DealDetail";
import BuyerLog from "../../components/buyers/BuyerLog";
import CompanyPeople from "../../components/pipeline/CompanyPeople";
import { peopleAtCompany } from "../../lib/companyPeople";
import { bankerFirstName } from "../../lib/relationship";
import { funnel, listBuyers, reached } from "../../lib/buyers";
import RegulatoryPanel from "../../components/regulatory/RegulatoryPanel";
import { listFilings, listVotes } from "../../lib/regulatoryStore";
import DealDocuments from "../../components/documents/DealDocuments";
import { latestNdaByBuyer, listDocuments } from "../../lib/documents";
import type { Deal, Task, TeamMember, UserOption } from "../../components/pipeline/types";
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

  const team = db()
    .prepare(
      `SELECT t.user_id, u.name, t.role FROM deal_team t JOIN users u ON u.id = t.user_id
       WHERE t.deal_id = ? ORDER BY CASE t.role WHEN 'lead' THEN 0 ELSE 1 END, u.name`
    )
    .all(id) as TeamMember[];
  const users = db().prepare("SELECT id, name FROM users WHERE disabled = 0 ORDER BY name").all() as UserOption[];
  const buyers = listBuyers(id);
  const figTrack = (deal as Deal & { fig_track?: number }).fig_track ?? 0;
  const regulatory = { fig_track: figTrack, filings: listFilings(id), votes: listVotes(id) };
  const documents = listDocuments(id);
  const ndaDocs = latestNdaByBuyer(id);
  const cfg = { stageProbability: firm.stageProbability, closedStages: firm.closedStages };

  return (
    <div>
      <div className="mb-4">
        <ButtonLink href="/pipeline" variant="quiet" size="sm" className="!px-0">
          Back to pipeline
        </ButtonLink>
      </div>
      <DealDetail deal={deal} tasks={tasks} timeline={timeline} stages={firm.dealStages} isOwner={user.role === "owner"} cfg={cfg}
        team={team}
        users={users}
        people={
          <CompanyPeople
            companyId={deal.company_id}
            companyName={deal.company_name}
            banker={bankerFirstName()}
            primaryContactId={deal.primary_contact_id}
            dealId={deal.id}
            initial={peopleAtCompany(deal.company_id)}
          />
        }
      />
      <div className="mt-6">
        <BuyerLog dealId={deal.id} initial={{ items: buyers, funnel: funnel(buyers), reached: reached(buyers) }} ndaDocs={ndaDocs} />
      </div>
      <div className="mt-6">
        <DealDocuments dealId={deal.id} initial={documents} />
      </div>
      <div className="mt-6">
        <RegulatoryPanel dealId={deal.id} initial={regulatory} />
      </div>
    </div>
  );
}
