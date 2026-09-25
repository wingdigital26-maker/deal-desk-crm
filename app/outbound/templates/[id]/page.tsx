import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "../../../lib/db";
import PageHeader from "../../../components/crm/PageHeader";
import { ButtonLink } from "../../../components/ui/Button";
import TemplateEditor, { type TemplateData } from "../../../components/outbound/TemplateEditor";

export default async function TemplateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const template = db().prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateData | undefined;
  if (!template) notFound();

  return (
    <div className="max-w-5xl">
      <Link href="/outbound/templates" className="mb-4 inline-block text-sm text-[var(--ink-soft)] underline underline-offset-2">
        Back to templates
      </Link>
      <PageHeader
        title={template.name}
        actions={
          template.status === "approved" ? (
            <ButtonLink href={`/contacts?queueTemplate=${template.id}`}>Queue to contacts</ButtonLink>
          ) : undefined
        }
      />
      <TemplateEditor template={template} />
    </div>
  );
}
