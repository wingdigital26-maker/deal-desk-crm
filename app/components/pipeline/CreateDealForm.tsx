"use client";
import { useId, useState } from "react";
import { Button } from "../ui/Button";
import { FieldInput, inputClass } from "../crm/Field";
import CompanySearch from "./CompanySearch";
import type { CompanyOption, Deal } from "./types";

const SITUATIONS = [
  { value: "growth-partner", label: "Growth partner" },
  { value: "succession", label: "Succession" },
  { value: "strategic-transition", label: "Strategic transition" },
  { value: "other", label: "Other" },
] as const;

export default function CreateDealForm({
  defaultStage,
  stages,
  onCreated,
  onCancel,
}: {
  defaultStage: string;
  /** When provided, shows a stage selector (used for the header-level "New deal" action, which is not tied to a column). */
  stages?: readonly string[];
  onCreated: (deal: Deal) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const [company, setCompany] = useState<CompanyOption | null>(null);
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState(defaultStage);
  const [situation, setSituation] = useState<string>("");
  const [nextStep, setNextStep] = useState("");
  const [nextStepDue, setNextStepDue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!company) {
      setError("Pick a company first.");
      return;
    }
    if (!title.trim()) {
      setError("Give the deal a title.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: company.id,
          title: title.trim(),
          stage,
          situation: situation || undefined,
          next_step: nextStep.trim() || undefined,
          next_step_due: nextStepDue || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not create the deal.");
        return;
      }
      onCreated({ ...data.item, company_name: company.name, company_domain: company.domain, last_activity_at: null });
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <CompanySearch onSelect={setCompany} />
      <FieldInput label="Deal title" htmlFor={`${uid}-deal-title`}>
        <input
          id={`${uid}-deal-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass}
          placeholder="e.g. Sale of manufacturing operations"
        />
      </FieldInput>
      {stages && (
        <FieldInput label="Stage" htmlFor={`${uid}-deal-stage`}>
          <select id={`${uid}-deal-stage`} value={stage} onChange={(e) => setStage(e.target.value)} className={inputClass}>
            {stages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </FieldInput>
      )}
      <FieldInput label="Situation" htmlFor={`${uid}-deal-situation`}>
        <select id={`${uid}-deal-situation`} value={situation} onChange={(e) => setSituation(e.target.value)} className={inputClass}>
          <option value="">Not set</option>
          {SITUATIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </FieldInput>
      <div className="grid grid-cols-2 gap-3">
        <FieldInput label="Next step" htmlFor={`${uid}-deal-next-step`}>
          <input id={`${uid}-deal-next-step`} value={nextStep} onChange={(e) => setNextStep(e.target.value)} className={inputClass} />
        </FieldInput>
        <FieldInput label="Due" htmlFor={`${uid}-deal-next-step-due`}>
          <input
            id={`${uid}-deal-next-step-due`}
            type="date"
            value={nextStepDue}
            onChange={(e) => setNextStepDue(e.target.value)}
            className={inputClass}
          />
        </FieldInput>
      </div>
      {error && <div className="text-sm text-[var(--bad)]">{error}</div>}
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting} size="sm">
          {submitting ? "Creating..." : "Create deal"}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
