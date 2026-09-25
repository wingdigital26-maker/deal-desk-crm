"use client";
import { useState } from "react";
import { Field } from "./Field";
import ContactForm, { type ContactFormValues } from "./ContactForm";
import DoNotContactToggle from "./DoNotContactToggle";
import FindEmailAction from "./FindEmailAction";
import StatusLabel from "../ui/StatusLabel";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";
import { emailCheck } from "./format";

export default function ContactDetail({
  contact,
  companyName,
  companies,
}: {
  contact: ContactFormValues;
  companyName: string | null;
  companies: { id: number; name: string }[];
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <Panel title="Contact details">
        <ContactForm companies={companies} initial={contact} onCancel={() => setEditing(false)} />
      </Panel>
    );
  }

  const check = emailCheck({ email: contact.email, email_status: contact.email_status, do_not_contact: contact.do_not_contact ?? 0 });

  return (
    <Panel
      title="Contact details"
      actions={
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" value={contact.title} />
        <Field label="Company" value={companyName} />
        <Field label="Email" value={contact.email} />
        <Field label="Email check" value={<StatusLabel kind={check.kind}>{check.label}</StatusLabel>} />
        <Field label="Phone" value={contact.phone} />
        <Field
          label="LinkedIn"
          value={
            contact.linkedin_url ? (
              <a
                href={contact.linkedin_url}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--ink)] underline underline-offset-2 decoration-[var(--rule-strong)] hover:decoration-[var(--ink)]"
              >
                View profile
              </a>
            ) : null
          }
        />
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--rule)] pt-4">
        <DoNotContactToggle contactId={contact.id!} value={Boolean(contact.do_not_contact)} />
        {!contact.email && <FindEmailAction contactIds={[contact.id!]} label="Find email" />}
      </div>
    </Panel>
  );
}
