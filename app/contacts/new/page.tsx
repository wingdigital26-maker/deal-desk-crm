import { db } from "../../lib/db";
import PageHeader from "../../components/crm/PageHeader";
import ContactForm from "../../components/crm/ContactForm";

export const dynamic = "force-dynamic";

export default async function NewContactPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  const sp = await searchParams;
  const companyId = sp.companyId ? Number(sp.companyId) : null;
  const companies = companyId
    ? (db().prepare("SELECT id, name FROM companies WHERE id = ?").all(companyId) as { id: number; name: string }[])
    : [];
  return (
    <div className="max-w-2xl">
      <PageHeader title="New contact" subtitle="Add a person to the relationship map." />
      <div className="card p-6">
        <ContactForm
          companies={companies}
          initial={
            companyId
              ? {
                  first_name: "",
                  last_name: "",
                  title: "",
                  email: "",
                  email_status: "",
                  phone: "",
                  linkedin_url: "",
                  company_id: companyId,
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}
