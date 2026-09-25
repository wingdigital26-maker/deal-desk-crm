"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FieldInput, inputClass } from "./Field";
import type { Segment } from "../../../firm.config";
import { Button } from "../ui/Button";

export type CompanyFormValues = {
  id?: number;
  name: string;
  domain: string | null;
  segment_id: string;
  industry: string | null;
  city: string | null;
  state: string | null;
  employees: number | null;
  revenue_band: string | null;
  notes: string | null;
};

export default function CompanyForm({
  segments,
  initial,
  onCancel,
}: {
  segments: readonly Segment[];
  initial?: CompanyFormValues;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<CompanyFormValues>(
    initial ?? {
      name: "",
      domain: "",
      segment_id: segments[0]?.id ?? "",
      industry: "",
      city: "",
      state: "",
      employees: null,
      revenue_band: "",
      notes: "",
    }
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = Boolean(initial?.id);

  function set<K extends keyof CompanyFormValues>(key: K, value: CompanyFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!values.name.trim()) {
      setError("Company name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const url = isEdit ? `/api/companies/${initial!.id}` : "/api/companies";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save the company");
      if (isEdit) {
        router.refresh();
        onCancel?.();
      } else {
        router.push(`/companies/${data.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the company");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <p className="text-sm text-[var(--bad)]">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldInput label="Company name" htmlFor="name">
          <input id="name" className={inputClass} value={values.name} onChange={(e) => set("name", e.target.value)} required />
        </FieldInput>
        <FieldInput label="Domain" htmlFor="domain" hint="Used to catch duplicates.">
          <input id="domain" className={inputClass} value={values.domain ?? ""} onChange={(e) => set("domain", e.target.value)} placeholder="acme.com" />
        </FieldInput>
        <FieldInput label="Segment" htmlFor="segment_id">
          <select id="segment_id" className={inputClass} value={values.segment_id} onChange={(e) => set("segment_id", e.target.value)}>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </FieldInput>
        <FieldInput label="Industry" htmlFor="industry">
          <input id="industry" className={inputClass} value={values.industry ?? ""} onChange={(e) => set("industry", e.target.value)} />
        </FieldInput>
        <FieldInput label="City" htmlFor="city">
          <input id="city" className={inputClass} value={values.city ?? ""} onChange={(e) => set("city", e.target.value)} />
        </FieldInput>
        <FieldInput label="State" htmlFor="state">
          <input id="state" className={inputClass} value={values.state ?? ""} onChange={(e) => set("state", e.target.value)} />
        </FieldInput>
        <FieldInput label="Employees" htmlFor="employees">
          <input
            id="employees"
            type="number"
            min={0}
            className={inputClass}
            value={values.employees ?? ""}
            onChange={(e) => set("employees", e.target.value ? Number(e.target.value) : null)}
          />
        </FieldInput>
        <FieldInput label="Revenue band" htmlFor="revenue_band" hint="e.g. $3M-$10M">
          <input id="revenue_band" className={inputClass} value={values.revenue_band ?? ""} onChange={(e) => set("revenue_band", e.target.value)} />
        </FieldInput>
      </div>
      <FieldInput label="Notes" htmlFor="notes">
        <textarea id="notes" rows={3} className={inputClass} value={values.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
      </FieldInput>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving..." : isEdit ? "Save changes" : "Create company"}
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
