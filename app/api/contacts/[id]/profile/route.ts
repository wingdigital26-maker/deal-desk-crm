export const runtime = "nodejs";
import { db } from "../../../../lib/db";
import { requireUser } from "../../../../lib/session";
import { getCompanyProfile, contactOwnerView } from "../../../../lib/profile";

// The banker profile as seen from a contact: the company profile plus how the
// company's own site lists this person (if it does).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const contactId = Number(id);
  if (!Number.isInteger(contactId) || contactId <= 0) return Response.json({ error: "Invalid id" }, { status: 400 });
  const contact = db().prepare("SELECT id, first_name, last_name, title, linkedin_url, company_id FROM contacts WHERE id = ?").get(contactId) as
    | { id: number; first_name: string | null; last_name: string | null; title: string | null; linkedin_url: string | null; company_id: number | null }
    | undefined;
  if (!contact) return Response.json({ error: "Not found" }, { status: 404 });
  const profile = contact.company_id ? getCompanyProfile(contact.company_id) : null;
  return Response.json({ contact, profile, owner: profile ? contactOwnerView(contact, profile) : null });
}
