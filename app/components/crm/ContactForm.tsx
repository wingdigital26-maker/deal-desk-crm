"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FieldInput, inputClass } from "./Field";
import { Button } from "../ui/Button";
import CompanySearch from "../pipeline/CompanySearch";

export type ContactFormValues = {
  id?: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  email_status: string | null;
  phone: string | null;
  linkedin_url: string | null;
  company_id: number | null;
  do_not_contact?: number;
};

const EMAIL_STATUSES = ["", "valid", "verified", "accept-all", "mx-only", "no-mx", "unknown"];

export default function ContactForm({
  companies,
  initial,
  onCancel,
}: {
  /** The contact's current company, if any (0 or 1 rows). Picking another is a
   * typeahead against /api/companies, never a 4,000-option dropdown. */
  companies: { id: number; name: string }[];
  initial?: ContactFormValues;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ContactFormValues>(
    initial ?? {
      first_name: "",
      last_name: "",
      title: "",
      email: "",
      email_status: "",
      phone: "",
      linkedin_url: "",
      company_id: null,
    }
  );
  const [companyName, setCompanyName] = useState<string | null>(
    companies.find((c) => c.id === initial?.company_id)?.name ?? null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = Boolean(initial?.id);

  function set<K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!values.first_name?.trim() && !values.last_name?.trim()) {
      setError("First or last name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const url = isEdit ? `/api/contacts/${initial!.id}` : "/api/contacts";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save the contact");
      if (isEdit) {
        router.refresh();
        onCancel?.();
      } else {
        router.push(`/contacts/${data.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the contact");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <p className="text-sm text-[var(--bad)]">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldInput label="First name" htmlFor="first_name">
          <input id="first_name" className={inputClass} value={values.first_name ?? ""} onChange={(e) => set("first_name", e.target.value)} />
        </FieldInput>
        <FieldInput label="Last name" htmlFor="last_name">
          <input id="last_name" className={inputClass} value={values.last_name ?? ""} onChange={(e) => set("last_name", e.target.value)} />
        </FieldInput>
        <FieldInput label="Title" htmlFor="title">
          <input id="title" className={inputClass} value={values.title ?? ""} onChange={(e) => set("title", e.target.value)} />
        </FieldInput>
        {values.company_id ? (
          <FieldInput label="Company" htmlFor="company_id">
            <div className="flex min-h-[44px] items-center gap-2">
              <input id="company_id" readOnly value={companyName ?? `Company #${values.company_id}`} className={`${inputClass} flex-1`} />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  set("company_id", null);
                  setCompanyName(null);
                }}
              >
                Change
              </Button>
            </div>
          </FieldInput>
        ) : (
          <CompanySearch
            onSelect={(c) => {
              set("company_id", c.id);
              setCompanyName(c.name);
            }}
            placeholder="No company. Type to search by name or domain"
          />
        )}
        <FieldInput label="Email" htmlFor="email">
          <input id="email" type="email" className={inputClass} value={values.email ?? ""} onChange={(e) => set("email", e.target.value)} />
        </FieldInput>
        <FieldInput label="Email status" htmlFor="email_status">
          <select id="email_status" className={inputClass} value={values.email_status ?? ""} onChange={(e) => set("email_status", e.target.value || null)}>
            {EMAIL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || "Unknown"}
              </option>
            ))}
          </select>
        </FieldInput>
        <FieldInput label="Phone" htmlFor="phone">
          <input id="phone" className={inputClass} value={values.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
        </FieldInput>
        <FieldInput label="LinkedIn URL" htmlFor="linkedin_url">
          <input id="linkedin_url" className={inputClass} value={values.linkedin_url ?? ""} onChange={(e) => set("linkedin_url", e.target.value)} />
        </FieldInput>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving..." : isEdit ? "Save changes" : "Create contact"}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
