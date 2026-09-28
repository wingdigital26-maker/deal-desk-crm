import { notFound, redirect } from "next/navigation";
import { currentUser } from "../../../lib/session";
import { canSeeDeal } from "../../../lib/dealAccess";
import { db } from "../../../lib/db";
import { firm } from "../../../../firm.config";
import { ButtonLink } from "../../../components/ui/Button";
import Import4D from "../../../components/buyers/Import4D";

export const metadata = { title: `Import buyers | ${firm.productName}` };

// Import a 4Degrees Deal List (CSV) onto this deal's buyer log.
export default async function ImportBuyersPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0 || !canSeeDeal(user, id)) notFound();
  const deal = db()
    .prepare("SELECT d.id, d.title, c.name AS company_name FROM deals d JOIN companies c ON c.id = d.company_id WHERE d.id = ?")
    .get(id) as { id: number; title: string; company_name: string } | undefined;
  if (!deal) notFound();

  return (
    <div className="mx-auto max-w-[1100px]">
      <ButtonLink href={`/pipeline/${deal.id}`} variant="quiet" size="sm" className="!px-0">
        Back to {deal.company_name}
      </ButtonLink>
      <h1 className="display mt-1 text-[28px] text-[var(--ink)]">Import buyers from 4Degrees</h1>
      <p className="mt-1 max-w-[70ch] text-sm text-[var(--ink-soft)]">
        For {deal.title}. In 4Degrees open the Deal List, pick the list view with the columns you want, and export it as CSV.
        Nothing is saved until you press Import; buyers already on this log are skipped.
      </p>
      <div className="mt-5">
        <Import4D dealId={deal.id} />
      </div>
    </div>
  );
}
