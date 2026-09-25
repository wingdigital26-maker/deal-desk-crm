"use client";
// Editor for one template: subject/body, allowed-field picker, live lint,
// rendered preview with sample values. Any save recomputes the hash and
// resets status to draft (voiding approval). Submit is disabled while any
// block finding exists.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { LintFinding } from "../../lib/compliance";
import { lintText, renderTemplate } from "../../lib/compliance";
import { firm } from "../../../firm.config";
import { Button } from "../ui/Button";
import { inputClass } from "../crm/Field";
import { statusLabel, STATUS_TONE } from "./labels";

const MERGE_FIELD_OPTIONS = ["first_name", "last_name", "company_name", "city", "industry"] as const;

const SAMPLE_VALUES: Record<string, string> = {
  first_name: "Alex",
  last_name: "Rivera",
  company_name: "Rivera Manufacturing",
  city: "Dallas",
  industry: "industrial fabrication",
};

export type TemplateData = {
  id: number;
  name: string;
  segment_id: string;
  subject: string;
  body: string;
  allowed_merge_fields: string;
  content_hash: string;
  status: string;
  review_note: string | null;
};

function FindingRow({ f }: { f: LintFinding }) {
  const tone = f.severity === "block" ? "text-[var(--bad)]" : "text-[var(--warn)]";
  const label = f.severity === "block" ? "Must fix before submitting" : "Worth a second look";
  return (
    <li className={`flex items-start gap-2 text-sm ${tone}`}>
      <span className="mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium border-current">{label}</span>
      <span>
        {f.message} <span className="font-mono text-xs opacity-75">&ldquo;{f.match}&rdquo;</span>
      </span>
    </li>
  );
}

export default function TemplateEditor({ template }: { template: TemplateData }) {
  const router = useRouter();
  const [name, setName] = useState(template.name);
  const [segmentId, setSegmentId] = useState(template.segment_id);
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [allowed, setAllowed] = useState<string[]>(() => {
    try {
      return JSON.parse(template.allowed_merge_fields);
    } catch {
      return [];
    }
  });
  const [status, setStatus] = useState(template.status);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const findings = useMemo(() => lintText(`${subject}\n${body}`), [subject, body]);
  const blockFindings = findings.filter((f) => f.severity === "block");

  const preview = useMemo(() => {
    const merge: Record<string, string> = {};
    for (const f of allowed) merge[f] = SAMPLE_VALUES[f] ?? "sample";
    return renderTemplate({ subject, body, allowedMergeFields: allowed }, merge, {
      unsubscribeUrl: "https://example.com/unsubscribe/sample",
    });
  }, [subject, body, allowed]);

  function toggleField(field: string) {
    setAllowed((prev) => (prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]));
    setDirty(true);
  }

  async function save(skipConfirm = false) {
    if (!skipConfirm && status === "approved") {
      const ok = window.confirm(
        "This template is approved. Saving an edit sends it back to draft and it will need approval again. Continue?"
      );
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/templates/${template.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, subject, bodyText: body, allowedMergeFields: allowed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Save failed");
        return;
      }
      setStatus("draft");
      setDirty(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      if (dirty) await save();
      const res = await fetch(`/api/templates/${template.id}/submit`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Submit failed");
        return;
      }
      setStatus("pending");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <span className={`rounded border px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status] ?? ""}`}>
            {statusLabel(status)}
          </span>
          {template.review_note && status === "rejected" && (
            <span className="text-xs text-[var(--bad)]">Sent back: {template.review_note}</span>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm text-[var(--ink-soft)]">Name</label>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            className={inputClass}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-[var(--ink-soft)]">Segment</label>
          <select
            value={segmentId}
            onChange={(e) => {
              setSegmentId(e.target.value);
              setDirty(true);
            }}
            className={inputClass}
          >
            {firm.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm text-[var(--ink-soft)]">Subject</label>
          <input
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setDirty(true);
            }}
            className={inputClass}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-[var(--ink-soft)]">Body</label>
          <textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setDirty(true);
            }}
            rows={10}
            className={`${inputClass} font-mono`}
          />
        </div>

        <div>
          <div className="mb-1 text-sm text-[var(--ink-soft)]">Personalization fields</div>
          <div className="flex flex-wrap gap-2">
            {MERGE_FIELD_OPTIONS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => toggleField(f)}
                className={`min-h-[36px] rounded-full border px-3 text-xs font-medium ${
                  allowed.includes(f)
                    ? "border-[var(--navy)] bg-[var(--navy)] text-white"
                    : "border-[var(--rule-strong)] text-[var(--ink-soft)]"
                }`}
              >
                {`{{${f}}}`}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded border border-[var(--bad)]/30 bg-[var(--bad)]/5 px-3 py-2 text-sm text-[var(--bad)]">
            {error}
          </p>
        )}

        {status === "approved" && (
          <p className="text-xs text-[var(--ink-faint)]">
            This template is approved. Saving an edit sends it back to draft and it will need approval again.
          </p>
        )}

        <div className="flex gap-3">
          <Button type="button" variant="secondary" onClick={() => save()} disabled={saving}>
            {saving ? "Saving..." : "Save draft"}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={submitting || blockFindings.length > 0 || (status !== "draft" && status !== "rejected")}
            title={blockFindings.length > 0 ? "Fix the items that must be fixed before submitting" : undefined}
          >
            {submitting ? "Submitting..." : "Submit for approval"}
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <div className="mb-2 text-sm font-medium text-[var(--ink)]">Compliance check</div>
          {findings.length === 0 ? (
            <p className="text-sm text-[var(--ink-faint)]">No findings.</p>
          ) : (
            <ul className="space-y-2">
              {findings.map((f, i) => (
                <FindingRow key={i} f={f} />
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="mb-2 text-sm font-medium text-[var(--ink)]">Preview with sample values</div>
          <div className="card p-4">
            {preview.ok ? (
              <>
                <div className="mb-2 border-b border-[var(--rule)] pb-2 text-sm font-medium">{preview.subject}</div>
                <div className="whitespace-pre-wrap text-sm text-[var(--ink-soft)]">{preview.body}</div>
              </>
            ) : (
              <p className="text-sm text-[var(--bad)]">{preview.error}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
